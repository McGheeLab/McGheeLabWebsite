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
     DEMO SEAM (V3.632)
     ----------------------------------------------------------------
     teacher-demo.js installs ML.TC_DEMO so an admin can preview every
     teacher/student state (#/demo) against in-memory fixtures. When it
     is absent or inactive — the normal case for every real visitor —
     these resolve to the real Firestore data layer and the signed-in
     user, so production behavior is unchanged.
     ================================================================ */
  function demo() { const d = ML.TC_DEMO; return (d && d.active) ? d : null; }
  function src() { return demo()?.db || TC_DB; }
  function me() { return demo()?.uid || ML.Auth?.currentUser?.uid; }
  function myProfile() { return demo()?.profile || ML.Auth?.currentProfile || {}; }

  /* ================================================================
     TEACHER "VIEW AS STUDENT" (V3.636)
     ----------------------------------------------------------------
     A teacher can preview their own class page as one of THEIR students
     — the natural companion to the roster, and the way to confirm a
     student really has access (or really doesn't, after a Remove).

     This is a PREVIEW, not impersonation, and the distinction is the
     whole security argument: every read it performs is one the teacher
     already owns (their schedule, their roster), it never writes as the
     student, and firestore.rules is untouched. The scope is deliberately
     one class page — a teacher cannot list a student's OTHER enrollments
     (the read rule only admits enrollments where they are the teacher),
     so there is no "view as student's dashboard", by design.

     `_viewAs` carries its scheduleId so a stale preview can't leak onto
     another class after navigation.
     ================================================================ */
  let _viewAs = null;   // { scheduleId, studentUid, studentName, status } | null

  function viewAsFor(scheduleId) {
    return (_viewAs && _viewAs.scheduleId === scheduleId) ? _viewAs : null;
  }
  function clearViewAs() { _viewAs = null; }
  function setViewAs(next) { _viewAs = next; }

  /** May the signed-in user preview `scheduleId` as one of its students? */
  function canViewAsStudent(schedule) {
    const uid = me();
    if (!uid || !schedule) return false;
    return schedule.ownerUid === uid ||
      (demo() ? false : ML.Auth?.currentProfile?.role === 'admin');
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
    // Doc id IS the code, so this is a single get — the student enroll path.
    async getJoinCode(code) {
      const doc = await db().collection('joinCodes').doc(code).get();
      return doc.exists ? { code: doc.id, ...doc.data() } : null;
    },
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
    // V3.635 — `joinCode` is written on re-activation because the rule proves
    // a re-join against the code being redeemed NOW; the code stored when the
    // student first joined may since have been regenerated away.
    async setEnrollmentStatus(enrollmentId, status, joinCode) {
      const patch = { status, updatedAt: ts() };
      if (joinCode) patch.joinCode = joinCode;
      await db().collection('enrollments').doc(enrollmentId).update(patch);
    },
    // V3.632 — the module's only enrollment write, so the demo data layer
    // has a single method to intercept instead of a raw collection ref.
    // V3.635 — a teacher's Remove stamps `removedBy` so the rule can keep the
    // student from re-activating themselves with the code they already hold.
    // `removedBy` is outside the student-writable key set, so only the teacher
    // (or admin) can set or clear it.
    async removeStudent(enrollmentId) {
      await db().collection('enrollments').doc(enrollmentId)
        .update({ status: 'removed', removedBy: 'teacher', updatedAt: ts() });
    },
    async createEnrollment(scheduleId, uid, data) {
      await db().collection('enrollments').doc(TC_DB.enrollmentId(scheduleId, uid)).set(
        Object.assign({ scheduleId, studentUid: uid, createdAt: ts(), updatedAt: ts() }, data));
    },
    async setUserCategory(uid, category) {
      await ML.DB.updateUser(uid, { category });
      if (ML.Auth) ML.Auth.currentProfile = await ML.DB.getUser(uid);
    },
    // V3.634 — a student invited by a teacher is classified as a student AND
    // keeps a durable link to who invited them. `enrollments` stays the
    // authoritative record (its create is rules-gated on a live join code);
    // these user-doc fields are a denormalized convenience for the admin
    // panels, and because owners may write their own non-`role` fields they
    // are NOT a trust boundary — never gate anything on them.
    async linkStudentToTeacher(uid, teacherUid, school) {
      const patch = {
        category: 'student',
        teacherUids: firebase.firestore.FieldValue.arrayUnion(teacherUid),
        studentSince: ts()
      };
      if (school) patch.studentSchool = school;
      await ML.DB.updateUser(uid, patch);
      if (ML.Auth) ML.Auth.currentProfile = await ML.DB.getUser(uid);
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
    },

    /* ---- global module catalog (V3.669) ---- */
    // Admin curates teacherCatalog on rm/pages/admin-teachers.html?tab=catalog;
    // teachers pick from the published subset when assigning modules on #/teach.
    async publishedCatalog() {
      const snap = await db().collection('teacherCatalog').where('published', '==', true).get();
      const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      rows.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) ||
        String(a.title || '').localeCompare(String(b.title || '')));
      return rows;
    },
    // The owning teacher may update modules[] (grantedFolders stays pinned by
    // the schedules rule) — this is the single write path for class-wide
    // module assignment, ordering, due dates, and publish flags.
    async saveClassModules(scheduleId, modules) {
      await db().collection('schedules').doc(scheduleId).update({ modules, updatedAt: ts() });
    },
    // Per-student override on the enrollment doc. `override` of null deletes
    // the entry. Module ids contain dashes, so the key goes through FieldPath
    // rather than a dotted string path.
    async setModuleOverride(enrollmentId, moduleId, override) {
      const fp = new firebase.firestore.FieldPath('moduleOverrides', moduleId);
      await db().collection('enrollments').doc(enrollmentId).update(
        fp, override || firebase.firestore.FieldValue.delete(),
        'updatedAt', ts());
    },

    /* ---- assignments + submissions (V3.671) ---- */
    // Teacher list is keyed on teacherUid (client filters by class) because a
    // list rule is proven against the query's filters — a bare scheduleId
    // query can't prove ownership. Same reason the student query MUST carry
    // the status filter: a draft candidate would deny the whole query.
    async assignmentsForTeacher(uid) {
      const snap = await db().collection('assignments').where('teacherUid', '==', uid).get();
      return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    },
    async assignmentsForStudent(scheduleId) {
      const snap = await db().collection('assignments')
        .where('scheduleId', '==', scheduleId)
        .where('status', 'in', ['published', 'closed']).get();
      const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      rows.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) ||
        String(a.dueDate || '9999').localeCompare(String(b.dueDate || '9999')));
      return rows;
    },
    async saveAssignment(id, data) {
      data.updatedAt = ts();
      if (id) { await db().collection('assignments').doc(id).update(data); return id; }
      data.createdAt = ts();
      const ref = await db().collection('assignments').add(data);
      return ref.id;
    },
    async deleteAssignment(id) {
      await db().collection('assignments').doc(id).delete();
    },
    submissionId(assignmentId, uid) { return assignmentId + '_' + uid; },
    async mySubmission(assignmentId, uid) {
      const doc = await db().collection('submissions').doc(TC_DB.submissionId(assignmentId, uid)).get();
      return doc.exists ? { id: doc.id, ...doc.data() } : null;
    },
    // Create-or-update split because the rules key sets differ: create writes
    // the full doc (denormalized ids proven against the assignment), update
    // may touch only the student-editable keys and only until graded.
    async submitAssignment(assignment, student, patch) {
      const id = TC_DB.submissionId(assignment.id, student.uid);
      const ref = db().collection('submissions').doc(id);
      const existing = await ref.get();
      const body = Object.assign({
        studentName: student.name || '',
        submittedAt: ts(), updatedAt: ts(), lastEditedBy: student.uid
      }, patch);
      if (existing.exists) { await ref.update(body); return id; }
      await ref.set(Object.assign({
        assignmentId: assignment.id,
        scheduleId: assignment.scheduleId,
        teacherUid: assignment.teacherUid,
        studentUid: student.uid
      }, body));
      return id;
    },
    async submissionsForTeacher(uid) {
      const snap = await db().collection('submissions').where('teacherUid', '==', uid).get();
      return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    },
    async gradeSubmission(submissionId, grade) {
      await db().collection('submissions').doc(submissionId)
        .update({ grade, updatedAt: ts() });
    },

    /* ---- module engagement (V3.672) ---- */
    // One pre-aggregated doc per (class, student) — moduleStats/{sid}_{uid},
    // the enrollments composite-id trick a third time. The student's own
    // client writes FieldValue.increment patches (concurrent tabs are safe);
    // no raw event log, no Cloud Function. Self-reported counters, not
    // grades — the rules only stop cross-doc and identity spoofing.
    statsId(scheduleId, uid) { return scheduleId + '_' + uid; },
    async statsForTeacher(uid) {
      const snap = await db().collection('moduleStats').where('teacherUid', '==', uid).get();
      return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    },
    // patch: {moduleId, opens?, seconds?, sections?: [ids], railCount?, scrollPct?}
    async recordEngagement(scheduleId, student, patch) {
      const ref = db().collection('moduleStats').doc(TC_DB.statsId(scheduleId, student.uid));
      const FP = firebase.firestore.FieldPath;
      const inc = firebase.firestore.FieldValue.increment;
      const m = patch.moduleId;
      const args = [];
      if (patch.opens) args.push(new FP('modules', m, 'opens'), inc(patch.opens));
      if (patch.seconds) args.push(new FP('modules', m, 'seconds'), inc(patch.seconds));
      for (const sid of (patch.sections || [])) {
        args.push(new FP('modules', m, 'sections', sid), true);
      }
      if (patch.railCount != null) args.push(new FP('modules', m, 'railCount'), patch.railCount);
      if (patch.scrollPct != null) args.push(new FP('modules', m, 'scrollPct'), patch.scrollPct);
      if (patch.opens) args.push(new FP('modules', m, 'lastOpenAt'), ts());
      if (!args.length) return;
      args.push(new FP('lastActiveAt'), ts(), new FP('studentName'), student.name || '');
      try {
        await ref.update(args[0], args[1], ...args.slice(2));
      } catch (e) {
        // First write for this (class, student): create the full doc — the
        // create rule proves the composite id against the caller's own
        // enrollment doc (same id), so this needs no extra reads.
        const mod = {};
        if (patch.opens) mod.opens = patch.opens;
        if (patch.seconds) mod.seconds = patch.seconds;
        if (patch.sections?.length) {
          mod.sections = {};
          for (const sid of patch.sections) mod.sections[sid] = true;
        }
        if (patch.railCount != null) mod.railCount = patch.railCount;
        if (patch.scrollPct != null) mod.scrollPct = patch.scrollPct;
        mod.lastOpenAt = ts();
        await ref.set({
          scheduleId,
          teacherUid: student.teacherUid,
          studentUid: student.uid,
          studentName: student.name || '',
          lastActiveAt: ts(),
          modules: { [m]: mod }
        });
      }
    },

    /* ---- engagement hub (V3.673) ---- */
    // Listing (engageProfiles) follows the teacherProfiles approval pattern:
    // owner saves land draft/pending, only admin approves. The street address
    // lives in the private/contact subdoc (owner+admin only) and reaches a
    // requester only when the teacher copies it onto a CONFIRMED request.
    async getEngageProfile(uid) {
      const doc = await db().collection('engageProfiles').doc(uid).get();
      return doc.exists ? { id: doc.id, ...doc.data() } : null;
    },
    async saveEngageProfile(uid, data, submit) {
      data.teacherUid = uid;
      data.status = submit ? 'pending' : 'draft';
      data.updatedAt = ts();
      await db().collection('engageProfiles').doc(uid).set(data, { merge: true });
    },
    async approvedEngageProfiles() {
      const snap = await db().collection('engageProfiles').where('status', '==', 'approved').get();
      return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    },
    async getEngageContact(uid) {
      const doc = await db().collection('engageProfiles').doc(uid)
        .collection('private').doc('contact').get();
      return doc.exists ? doc.data() : null;
    },
    async saveEngageContact(uid, data) {
      await db().collection('engageProfiles').doc(uid)
        .collection('private').doc('contact').set(data, { merge: true });
    },
    /* ---- opportunities (V3.791) ----
       An opportunity is ONE thing a teacher would like (a guest talk on X for
       AP Physics) with SEVERAL dates that would work for it. Presenters sign
       up for the opportunity, ticking the dates they could do; the teacher
       accepts one presenter (or several, if presentersWanted > 1) and picks
       the date. `dateKeys` mirrors dates[].date as plain strings so the
       request rule can check the presenter's picks with hasAll(). pendingCount
       / acceptedCount are maintained server-side by functions/engage-notify.js
       from the requests, so presenters can see "pending acceptance" without
       reading anyone else's request. ---- */
    async myOpportunities(uid) {
      const snap = await db().collection('engageOpportunities').where('teacherUid', '==', uid).get();
      return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    },
    async openOpportunities() {
      const snap = await db().collection('engageOpportunities').where('status', '==', 'open').get();
      return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    },
    async saveOpportunity(id, data) {
      if (Array.isArray(data.dates)) data.dateKeys = data.dates.map(d => d.date);
      data.updatedAt = ts();
      if (id) { await db().collection('engageOpportunities').doc(id).update(data); return id; }
      data.createdAt = ts();
      const ref = await db().collection('engageOpportunities').add(data);
      return ref.id;
    },
    async deleteOpportunity(id) {
      await db().collection('engageOpportunities').doc(id).delete();
    },
    async createEngageRequest(data) {
      data.status = 'pending';
      data.createdAt = ts(); data.updatedAt = ts();
      const ref = await db().collection('engageRequests').add(data);
      return ref.id;
    },
    async engageRequestsForTeacher(uid) {
      const snap = await db().collection('engageRequests').where('teacherUid', '==', uid).get();
      return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    },
    async engageRequestsForRequester(uid) {
      const snap = await db().collection('engageRequests').where('requesterUid', '==', uid).get();
      return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    },
    // Teacher decision — the rules limit this write to
    // status/location/teacherNote/decidedAt/updatedAt.
    async decideEngageRequest(id, status, extras) {
      const patch = Object.assign({ status, decidedAt: ts(), updatedAt: ts() }, extras || {});
      await db().collection('engageRequests').doc(id).update(patch);
    },
    async cancelEngageRequest(id) {
      await db().collection('engageRequests').doc(id)
        .update({ status: 'cancelled', updatedAt: ts() });
    },

    /* ---- presenters + visit follow-through (V3.785-787) ---- */
    // engagePresenters/{uid} — who a presenter is, filled in once on
    // #/presenters. Owner-writable except `blocked` (admin-only), which the
    // engageRequests create rule checks.
    async getPresenter(uid) {
      const doc = await db().collection('engagePresenters').doc(uid).get();
      return doc.exists ? { id: doc.id, ...doc.data() } : null;
    },
    async savePresenter(uid, data) {
      data.updatedAt = ts();
      await db().collection('engagePresenters').doc(uid).set(data, { merge: true });
    },
    async markEngageEmailed(id) {
      await db().collection('engageRequests').doc(id).update({ emailedAt: ts(), updatedAt: ts() });
    },
    // engageReviews/{requestId} — read ONLY by query: a get of a review that
    // doesn't exist yet can only be answered by dereferencing the missing
    // doc, which the rules deny (the V3.772 lesson).
    async reviewsForRequester(uid) {
      const snap = await db().collection('engageReviews').where('requesterUid', '==', uid).get();
      return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    },
    async reviewsForTeacher(uid) {
      const snap = await db().collection('engageReviews').where('teacherUid', '==', uid).get();
      return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    },
    async saveEngageReview(reqId, data, isNew) {
      data.updatedAt = ts();
      if (isNew) data.createdAt = ts();
      await db().collection('engageReviews').doc(reqId).set(data, { merge: true });
    },
    // Can the signed-in user browse the hub? Lab members always can; external
    // people need the engage:browse cap. Own userPermissions doc is
    // owner-readable, so this is one get; a missing doc means no caps.
    async myEngageCaps(uid) {
      try {
        const doc = await db().collection('userPermissions').doc(uid).get();
        return (doc.exists && doc.data().caps) || [];
      } catch (e) { return []; }
    }
  };

  /* ================================================================
     JOIN A CLASS (shared by student dashboard + class page)
     ================================================================ */
  async function joinClassWithCode(rawCode) {
    const Auth = ML.Auth;
    if (!demo() && !Auth?.currentUser) throw new Error('Please sign in first.');
    const code = String(rawCode || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(code)) throw new Error('Class codes are 6 letters/numbers.');

    const codeData = await src().getJoinCode(code);
    if (!codeData || codeData.active !== true) {
      throw new Error('That code is not valid or is no longer active.');
    }
    const { scheduleId, teacherUid } = codeData;
    const sched = await src().getSchedule(scheduleId);
    if (!sched) throw new Error('Class not found.');
    if (sched.enrollmentOpen === false) throw new Error('Enrollment is currently closed for this class.');

    const uid = me();
    const p = myProfile();
    const existing = await src().getEnrollment(scheduleId, uid);
    if (existing && existing.status === 'active') return scheduleId; // already in — idempotent
    if (existing) {
      // Re-join after leaving/removal still requires a live code — checked
      // above by the client and, since V3.635, proved again by the rule
      // against the code passed here.
      await src().setEnrollmentStatus(existing.id, 'active', code);
    } else {
      await src().createEnrollment(scheduleId, uid, {
        studentName: p.name || Auth?.currentUser?.displayName || '',
        studentEmail: p.email || Auth?.currentUser?.email || '',
        teacherUid,
        joinCode: code,
        status: 'active'
      });
    }
    // V3.634 — joining classifies the user as a student and records which
    // teacher invited them, so the association outlives the enrollment (a
    // removed student, or a deleted class, still shows who they came from).
    // Teachers are never reclassified — a teacher may preview their own class.
    // A failure here must not fail the join: the student IS enrolled (the
    // write above succeeded), so we surface it and move on rather than
    // telling them the code didn't work.
    if ((p.category || 'guest') !== 'teacher') {
      try {
        await src().linkStudentToTeacher(uid, teacherUid, sched.school || '');
      } catch (e) {
        console.warn('[TC] student/teacher link failed — enrollment stands', e);
      }
    }
    return scheduleId;
  }

  // Soft gate for the module viewer: enrolled student, owning teacher,
  // or admin. Static module HTML remains fetchable by URL — accepted
  // trade-off recorded in the V3.304 plan.
  async function tcCanViewModules(classId, schedule) {
    // V3.636 — a teacher previewing one of their students answers as that
    // student would, so a removed student's lockout is visible (and so the
    // preview carries into the module viewer, not just the class page).
    const va = viewAsFor(classId);
    if (va && canViewAsStudent(schedule)) return va.status === 'active';

    // V3.632 — in demo preview the persona decides, not the signed-in admin
    // (who would otherwise pass every gate and hide the student experience).
    const d = demo();
    if (d) {
      if (d.signedOut) return false;
      if (schedule.ownerUid === d.uid) return true;
      const de = await d.db.getEnrollment(classId, d.uid);
      return !!(de && de.status === 'active');
    }
    await waitForAuth();
    const Auth = ML.Auth;
    if (!Auth?.currentUser) return false;
    if (Auth.currentProfile?.role === 'admin') return true;
    if (schedule.ownerUid === me()) return true;
    const e = await src().getEnrollment(classId, me()).catch(() => null);
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
          await src().submitReview({
            authorUid: me(),
            authorName: Auth.currentProfile?.name || '',
            authorRole: form.dataset.role,
            scheduleId,
            teacherUid: cls?.teacherUid || me(),
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
          await src().updateReview(btn.dataset.editReview, { text: text.trim() });
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
    document.getElementById('dash-logout-btn')?.addEventListener('click', () =>
      demo() ? demo().note('Sign Out is disabled in demo preview.') : Auth.logout());
    if (ML.wireGuestProfileCard) ML.wireGuestProfileCard();
    const uid = me();

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

  // V3.669 — the dashboard card is now a summary; class management (codes,
  // rosters, modules, due dates) lives on its own page at #/teach
  // (teacher-teach.js), linked from here and from the Classes page banner.
  async function loadTeacherClasses(uid) {
    const el = document.getElementById('tc-classes-card');
    if (!el) return;
    const [classes, codes, roster] = await Promise.all([
      src().myTeacherClasses(uid),
      src().myJoinCodes(uid),
      src().rosterForTeacher(uid)
    ]);

    if (!classes.length) {
      el.innerHTML = `<h3>My Classes</h3>
        <p class="tc-muted">No classes yet. Once the lab approves your request, your class will appear here with a join code for your students.</p>`;
      return;
    }

    let html = `<h3>My Classes</h3>
      <p><a class="btn btn-primary" href="#/teach">Open teaching dashboard &rarr;</a></p>
      <p class="tc-muted">Manage join codes, assign modules, and see your students there.</p>`;
    for (const cls of classes) {
      const activeCode = codes.find(c => c.scheduleId === cls.id && c.active);
      const students = roster.filter(r => r.scheduleId === cls.id && r.status === 'active');
      const assigned = (cls.modules || []).filter(m => m.published !== false).length;
      html += `
      <div class="tc-class-block" data-schedule="${esc(cls.id)}">
        <div class="tc-class-head">
          <a href="#/teach/${esc(cls.id)}"><strong>${esc(cls.title || cls.id)}</strong></a>
          <span class="tc-muted">${cls.enrollmentOpen !== false ? 'Enrollment open' : 'Enrollment closed'}</span>
        </div>
        <p class="tc-muted">
          ${students.length} student${students.length === 1 ? '' : 's'}
          · ${assigned} module${assigned === 1 ? '' : 's'} assigned
          · code: ${activeCode ? `<span class="tc-code">${esc(activeCode.code)}</span>` : '<em>none active</em>'}
        </p>
        <p><a class="btn btn-secondary btn-small" href="#/teach/${esc(cls.id)}">Manage class</a>
           <a class="btn btn-secondary btn-small" href="#/classes/${esc(cls.id)}">View as page</a></p>
      </div>`;
    }
    el.innerHTML = html;
  }

  async function loadRequestCard(uid) {
    const el = document.getElementById('tc-request-card');
    if (!el) return;
    const [requests, folders] = await Promise.all([
      src().myRequests(uid),
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
        try { await src().withdrawRequest(btn.dataset.withdraw); await loadRequestCard(uid); }
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
          await src().createRequest({
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
    const prof = await src().getTeacherProfile(uid) || {};
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
        await src().saveTeacherProfile(uid, {
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
      src().myTeacherClasses(uid),
      src().myReviews(uid)
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
        <div class="dash-card" id="tc-assignments-card"><h3>Assignments</h3><p class="tc-muted">Loading…</p></div>
        <div id="tc-review-slot"></div>
      </div>
    </div>`;
  }

  async function wireStudentDashboard() {
    const Auth = ML.Auth;
    document.getElementById('dash-logout-btn')?.addEventListener('click', () =>
      demo() ? demo().note('Sign Out is disabled in demo preview.') : Auth.logout());
    if (ML.wireGuestProfileCard) ML.wireGuestProfileCard();
    const uid = me();

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
      loadStudentAssignments(uid).catch(e => panelError('tc-assignments-card', e)),
      loadStudentReviewSlot(uid).catch(e => console.warn('[TC] review slot', e))
    ]);
  }

  /* ================================================================
     STUDENT ASSIGNMENTS CARD (V3.671)
     ----------------------------------------------------------------
     Published/closed assignments across every active class, each with
     its submission state: mark-done, an inline text response (editable
     until graded), or the grade the teacher recorded.
     ================================================================ */
  function fmtDueShort(d) {
    const dt = d ? new Date(d + 'T00:00') : null;
    return dt && !isNaN(dt) ? dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
  }
  const GRADE_LABELS = { complete: '✓ Complete', incomplete: '✕ Incomplete', excused: '– Excused' };

  async function loadStudentAssignments(uid) {
    const el = document.getElementById('tc-assignments-card');
    if (!el) return;
    // V3.771 — teachers no longer set coursework here (the hub's assignment
    // editor is gone; how they assign and grade is their own business), so
    // this card only appears for a student who actually has assignments
    // from before. With none, it would be a permanently empty card.
    const enrollments = (await src().myEnrollments(uid)).filter(e => e.status === 'active');
    if (!enrollments.length) { el.hidden = true; return; }
    const schedules = await Promise.all(enrollments.map(e => src().getSchedule(e.scheduleId).catch(() => null)));
    const perClass = await Promise.all(enrollments.map(async (e, i) => {
      const assignments = await src().assignmentsForStudent(e.scheduleId).catch(() => []);
      const subs = await Promise.all(assignments.map(a => src().mySubmission(a.id, uid).catch(() => null)));
      return { title: schedules[i]?.title || e.scheduleId, assignments, subs };
    }));

    const today = new Date().toISOString().slice(0, 10);
    let html = '<h3>Assignments</h3>';
    let any = false;
    for (const cls of perClass) {
      if (!cls.assignments.length) continue;
      any = true;
      html += `<div class="tc-assign-class"><strong>${esc(cls.title)}</strong>`;
      cls.assignments.forEach((a, i) => {
        const sub = cls.subs[i];
        const overdue = a.dueDate && a.dueDate < today && !sub;
        const closed = a.status === 'closed';
        html += `
        <div class="tc-assign-row" data-assign="${esc(a.id)}">
          <div class="tc-assign-head">
            <span class="tc-assign-title">${esc(a.title || 'Assignment')}</span>
            ${a.points != null ? `<span class="tc-muted">${esc(String(a.points))} pts</span>` : ''}
            ${a.dueDate ? `<span class="tc-assign-due${overdue ? ' overdue' : ''}">due ${esc(fmtDueShort(a.dueDate))}</span>` : ''}
            ${closed ? '<span class="tc-chip tc-chip-draft">Closed</span>' : ''}
          </div>
          ${a.description ? `<p class="tc-muted tc-assign-desc">${esc(a.description)}</p>` : ''}
          ${sub?.grade ? `
            <div class="tc-assign-grade">
              <strong>${esc(GRADE_LABELS[sub.grade.outcome] || sub.grade.outcome || 'Graded')}</strong>
              ${sub.grade.score != null ? `<span>${esc(String(sub.grade.score))}${a.points != null ? ' / ' + esc(String(a.points)) : ''}</span>` : ''}
              ${sub.grade.feedback ? `<p class="tc-muted">${esc(sub.grade.feedback)}</p>` : ''}
            </div>` : `
            <div class="tc-assign-state">
              ${sub ? `<span class="tc-chip tc-chip-approved">${sub.status === 'done' ? 'Marked done' : 'Submitted'}</span>
                       ${sub.text ? `<p class="tc-assign-mytext tc-muted">${esc(sub.text)}</p>` : ''}` : ''}
              ${closed ? (sub ? '' : '<span class="tc-muted">This assignment is closed.</span>') : `
                <div class="tc-assign-actions">
                  ${sub?.status === 'done' ? '' : `<button class="btn btn-secondary btn-small" data-mark-done>${sub ? 'Mark done instead' : 'Mark done'}</button>`}
                  <button class="btn btn-secondary btn-small" data-write-response>${sub?.text ? 'Edit response' : 'Write response'}</button>
                </div>
                <form class="tc-assign-form" hidden>
                  <textarea rows="3" placeholder="Your answer…">${esc(sub?.text || '')}</textarea>
                  <button type="submit" class="btn btn-primary btn-small">Submit response</button>
                </form>`}
              <span class="form-status tc-assign-status" hidden></span>
            </div>`}
        </div>`;
      });
      html += '</div>';
    }
    if (!any) { el.hidden = true; return; }
    el.hidden = false;
    el.innerHTML = html;

    const p = myProfile();
    const student = { uid, name: p.name || ML.Auth?.currentUser?.displayName || '' };
    const flat = perClass.flatMap(c => c.assignments);

    el.querySelectorAll('.tc-assign-row').forEach(row => {
      const a = flat.find(x => x.id === row.dataset.assign);
      if (!a) return;
      const st = row.querySelector('.tc-assign-status');
      const fail = (e) => { if (st) { st.textContent = 'Could not save: ' + e.message; st.className = 'form-status error tc-assign-status'; st.hidden = false; } };
      row.querySelector('[data-mark-done]')?.addEventListener('click', async (ev) => {
        ev.target.disabled = true;
        try { await src().submitAssignment(a, student, { status: 'done' }); await loadStudentAssignments(uid); }
        catch (e) { ev.target.disabled = false; fail(e); }
      });
      row.querySelector('[data-write-response]')?.addEventListener('click', () => {
        const form = row.querySelector('.tc-assign-form');
        if (form) form.hidden = !form.hidden;
      });
      row.querySelector('.tc-assign-form')?.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const text = ev.target.querySelector('textarea').value.trim();
        if (!text) { fail(new Error('write something first')); return; }
        try { await src().submitAssignment(a, student, { status: 'submitted', text }); await loadStudentAssignments(uid); }
        catch (e) { fail(e); }
      });
    });
  }

  async function loadStudentClasses(uid) {
    const el = document.getElementById('tc-myclasses-card');
    if (!el) return;
    const enrollments = (await src().myEnrollments(uid)).filter(e => e.status === 'active');
    if (!enrollments.length) {
      el.innerHTML = '<h3>My Classes</h3><p class="tc-muted">You haven’t joined a class yet.</p>';
      return;
    }
    const schedules = await Promise.all(enrollments.map(e => src().getSchedule(e.scheduleId).catch(() => null)));
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
      src().myEnrollments(uid),
      src().myReviews(uid)
    ]);
    const active = enrollments.filter(e => e.status === 'active');
    const schedules = await Promise.all(active.map(e => src().getSchedule(e.scheduleId).catch(() => null)));
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

    // V3.632 — the demo persona decides which gate renders; the signed-out
    // preview can't key off Auth.currentUser (the admin really is signed in).
    if (demo() ? demo().signedOut : !Auth?.currentUser) {
      content.innerHTML = `
        <div class="section card"><div class="tc-gate-card">
          <h3>Sign in to view this class</h3>
          <p class="tc-muted">This class is run by ${esc(schedule.teacherName || 'your teacher')}${schedule.school ? ' at ' + esc(schedule.school) : ''}. Sign in with Google, then enter your class code.</p>
          <button class="btn btn-primary" id="tc-gate-signin">Sign in with Google</button>
          <div id="tc-gate-status" class="form-status" hidden></div>
        </div></div>`;
      document.getElementById('tc-gate-signin')?.addEventListener('click', async () => {
        const st = document.getElementById('tc-gate-status');
        if (demo()) { demo().note('Google sign-in is disabled in demo preview — switch persona instead.'); return; }
        try {
          await Auth.googleLogin();
          await wireTeacherClassPage(scheduleId, schedule);
        } catch (e) {
          st.textContent = 'Sign-in failed: ' + e.message; st.className = 'form-status error'; st.hidden = false;
        }
      });
      return;
    }

    // V3.636 — a teacher previewing one of their students keeps the switcher
    // on screen in every state, including the locked-out one; that IS the
    // thing being checked after a Remove.
    const va = viewAsFor(scheduleId);
    const mayPreview = canViewAsStudent(schedule);
    const previewStrip = mayPreview ? await viewAsStripHTML(scheduleId, schedule) : '';

    const canView = await tcCanViewModules(scheduleId, schedule);
    if (!canView) {
      content.innerHTML = previewStrip + `
        <div class="section card"><div class="tc-gate-card">
          <h3>Enter your class code</h3>
          <p class="tc-muted">Ask your teacher for the 6-character code for ${esc(schedule.title || 'this class')}.</p>
          <form id="tc-gate-join" class="tc-join-form">
            <input type="text" id="tc-gate-code" maxlength="6" autocomplete="off" placeholder="ABC123" aria-label="Class code">
            <button type="submit" class="btn btn-primary">Join Class</button>
          </form>
          <div id="tc-gate-status" class="form-status" hidden></div>
        </div></div>`;
      wireViewAsStrip(scheduleId, schedule);
      document.getElementById('tc-gate-join')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const st = document.getElementById('tc-gate-status');
        if (va) {
          st.textContent = 'Preview only — ' + (va.studentName || 'this student') +
            ' would enter their code here. Nothing was submitted.';
          st.className = 'form-status'; st.hidden = false;
          return;
        }
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

    // Enrolled student, owning teacher, or admin. While previewing as a
    // student, the teacher's own affordances are hidden — otherwise the
    // preview would show something no student ever sees.
    const isOwner = !va && schedule.ownerUid === me();
    const isAdmin = (demo() || va) ? false : Auth.currentProfile?.role === 'admin';

    // V3.669 — per-student overrides (set by the teacher on #/teach) hide a
    // module or move its due date for one student. Owners/admins see the
    // class-wide list; the view-as preview applies the previewed student's
    // overrides, which is exactly what the preview exists to check.
    let overrides = {};
    const overrideUid = va ? va.studentUid : ((isOwner || isAdmin) ? null : me());
    if (overrideUid) {
      const enr = await src().getEnrollment(scheduleId, overrideUid).catch(() => null);
      overrides = (enr && enr.moduleOverrides) || {};
    }
    const fmtDue = (d) => {
      const dt = d ? new Date(d + 'T00:00') : null;
      return dt && !isNaN(dt) ? dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
    };
    const modules = (schedule.modules || [])
      .filter(m => m.published !== false)
      .filter(m => !(overrides[m.id] && overrides[m.id].hidden))
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

    content.innerHTML = previewStrip + `
      ${(isOwner || isAdmin) ? `
      <div class="section card tc-owner-strip">
        <span>${isOwner ? 'This is your class.' : 'Viewing as admin.'}</span>
        ${isOwner ? `<a href="#/teach/${esc(scheduleId)}" class="btn btn-secondary btn-small">Manage this class</a>` : ''}
      </div>` : ''}
      ${schedule.description ? `<div class="section card"><p>${esc(schedule.description)}</p></div>` : ''}
      <div class="section card">
        <h3>Modules</h3>
        ${modules.length ? `<div class="tc-module-list">
          ${modules.map((m, i) => {
            const due = (overrides[m.id] && overrides[m.id].dueDate) || m.dueDate || '';
            return `
            <!-- V3.716 — link by module id, not filename. A teacher granted two
                 folders gets two entries named overview.html (buildModules walks
                 every granted folder), and the old filename route resolved by
                 first match: the second module was unreachable and opened the
                 first one's folder. Catalog ids ({folder}--{basename}) are
                 already unique, and wireModuleViewer resolves ids first. -->
            <a class="tc-module-item" href="#/classes/${esc(scheduleId)}/modules/${encodeURIComponent(m.id || m.htmlFile)}">
              <span class="tc-module-num">${i + 1}</span>
              <span class="tc-module-title">${esc(m.title || m.htmlFile)}</span>
              ${due ? `<span class="tc-module-due">due ${esc(fmtDue(due))}</span>` : ''}
              <span class="tc-module-arrow">&rarr;</span>
            </a>`;
          }).join('')}
        </div>` : '<p class="tc-muted">No modules published yet.</p>'}
      </div>
      <div class="section card">
        <h3>How was it?</h3>
        <p class="tc-muted">When you’ve worked through the materials, we’d love a short review — it helps other schools find these modules. Write one from <a href="#/dashboard">your dashboard</a>.</p>
      </div>`;

    wireViewAsStrip(scheduleId, schedule);
  }

  /* ---- view-as strip (teacher-only) ---- */
  async function viewAsStripHTML(scheduleId, schedule) {
    let roster = [];
    try {
      roster = (await src().rosterForTeacher(schedule.ownerUid))
        .filter(r => r.scheduleId === scheduleId);
    } catch (e) {
      // A teacher can always list their own roster; an admin previewing
      // someone else's class cannot (the read rule is teacher/student/admin
      // per doc, but the LIST query is keyed on teacherUid). Degrade to the
      // strip with no options rather than breaking the page.
      console.warn('[TC] view-as roster unavailable', e);
    }
    roster.sort((a, b) => (a.studentName || '').localeCompare(b.studentName || ''));
    const va = viewAsFor(scheduleId);
    if (!roster.length && !va) return '';

    return `
      <div class="section card tc-viewas" role="toolbar" aria-label="View as student">
        <span class="tc-viewas-label">Viewing as:</span>
        <button type="button" class="tc-viewas-btn${va ? '' : ' tc-viewas-on'}" data-viewas-self>Myself (teacher)</button>
        <select id="tc-viewas-select" aria-label="Pick a student">
          <option value="">— pick a student —</option>
          ${roster.map(r => `<option value="${esc(r.studentUid)}"${va && va.studentUid === r.studentUid ? ' selected' : ''}>${esc(r.studentName || r.studentEmail || r.studentUid)}${r.status === 'active' ? '' : ' (removed)'}</option>`).join('')}
        </select>
        ${va ? `<span class="tc-viewas-note">Preview — this is ${esc(va.studentName || 'the student')}’s view of your class. Nothing you click here is saved as them.</span>`
             : '<span class="tc-viewas-note tc-muted">Check what a student sees — including a student you removed.</span>'}
      </div>`;
  }

  function wireViewAsStrip(scheduleId, schedule) {
    const sel = document.getElementById('tc-viewas-select');
    if (sel) {
      sel.addEventListener('change', async () => {
        const studentUid = sel.value;
        if (!studentUid) { clearViewAs(); return wireTeacherClassPage(scheduleId, schedule); }
        // The enrollment doc is the source of truth for status, and the
        // teacher may read it (they are its teacherUid) — so previewing
        // needs no access the teacher doesn't already have.
        const e = await src().getEnrollment(scheduleId, studentUid).catch(() => null);
        if (!e) return;
        _viewAs = {
          scheduleId, studentUid,
          studentName: e.studentName || e.studentEmail || studentUid,
          status: e.status
        };
        await wireTeacherClassPage(scheduleId, schedule);
      });
    }
    document.querySelector('[data-viewas-self]')?.addEventListener('click', async () => {
      clearViewAs();
      await wireTeacherClassPage(scheduleId, schedule);
    });
  }

  /* ================================================================
     PUBLIC SECTIONS — classes-page reviews strip + team-page teachers
     ================================================================ */
  async function renderClassReviewsSection(parentEl) {
    if (!parentEl || !db()) return;
    let reviews;
    try { reviews = await src().approvedReviews(12); } catch (e) { return; }
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
    try { profiles = await src().approvedTeacherProfiles(); } catch (e) { return; }
    if (!profiles.length) return;

    let featuredReviews = [];
    try {
      featuredReviews = (await src().approvedReviews(50)).filter(r => r.featured);
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
  ML.tcClearViewAs = clearViewAs;   // V3.636 — drop a stale preview on logout
  ML.tcSetViewAs = setViewAs;       // V3.669 — #/teach roster jumps into a student preview
  ML.tcViewAsFor = viewAsFor;       // V3.672 — the engagement beacon must skip teacher previews
  ML.tcManifestFolders = manifestFolders; // V3.669 — folder labels for the #/teach module picker
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
