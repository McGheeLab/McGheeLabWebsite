/* ================================================================
   TEACHER DEMO MODE — admin preview of every external-user state
   (V3.632)
   ----------------------------------------------------------------
   The teacher/student platform (V3.304) only renders for users whose
   role is 'guest', so an admin can never reach those screens on their
   own account, and states like "request denied", "15 students", or
   "removed student hits the code gate" take a multi-account round trip
   to manufacture. This file lets an admin open #/demo, pick a persona,
   and see the REAL render/wire functions run against in-memory
   fixtures.

   How it plugs in — teacher-classes.js resolves its data layer and
   acting uid through src()/me(), which return this module's DEMO_DB and
   persona uid while a demo is active and the real Firestore layer
   otherwise. user-system.js, class-builder.js, and app.js each carry a
   small demo branch. Nothing here writes to Firestore: mutating calls
   change the in-memory world and append to a visible action log, so
   button wiring is exercised without touching production data.

   WHAT IT DOES NOT TEST: permissions. The browser is still signed in as
   the admin, so a read a real teacher would be denied still succeeds
   here. Permission fidelity comes from the firestore.rules emulator
   suite and from a second real Google account — see
   CodeLog/ClaudesPlan/V3.632_teacher_rules_findings.md.

   Loaded after teacher-classes.js. Inert until an admin starts a demo.
   ================================================================ */
(function () {
  'use strict';

  const ML = window.McgheeLab = window.McgheeLab || {};
  const SS_KEY = 'mcgheelab.tcDemo.persona';

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }
  function daysAgo(n) { return new Date(Date.now() - n * 86400000); }
  // 'YYYY-MM-DD' n days from now — module due dates use the repo date format.
  function daysFromNowISO(n) {
    return new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  }
  // V3.791 — the k-th upcoming occurrence of a weekday (0=Sun), as a LOCAL
  // 'YYYY-MM-DD' (toISOString() is UTC and is tomorrow after 5pm in Arizona).
  function upcoming(dow, k) {
    const d = new Date(); d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + ((dow - d.getDay() + 7) % 7 || 7) + 7 * (k || 0));
    const p2 = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
  }
  const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  function fakeCode() {
    let out = '';
    for (let i = 0; i < 6; i++) out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    return out;
  }

  /* ================================================================
     FIXTURE CAST
     ================================================================ */
  const TEACHER_UID = 'demo-teacher-dana';
  const STUDENT_UID = 'demo-student-miguel';
  const GUEST_UID   = 'demo-guest-sam';
  // V3.785 — presenters (the #/presenters side of the engagement hub).
  const PRESENTER_UID     = 'demo-pi-okafor';     // has visits: pending, upcoming, one to review
  const PRESENTER_NEW_UID = 'demo-presenter-jordan';
  const CC_TEACHER_UID    = 'demo-teacher-ravi';  // a community-college listing, so filters have two kinds
  const CLASS_1 = 'tc-demo-sunnyside';
  const CLASS_2 = 'tc-demo-sunnyside-p2';

  const ROSTER_1 = [
    'Aaliyah Chen', 'Marcus Webb', 'Priya Nair', 'Diego Santos', 'Emma Kowalski',
    'Tyrell Jackson', 'Sofia Moreno', 'Liam O’Donnell', 'Yuki Tanaka'
  ];
  const ROSTER_2 = ['Nadia Haddad', 'Owen Pierce', 'Grace Lim', 'Andre Boateng', 'Ruby Vasquez'];

  // Synchronous stand-in for the manifest expansion the admin approve
  // modal does. Replaced with the real manifest (same folder keys) as soon
  // as modules/manifest.json resolves — see refreshModulesFromManifest().
  const STUB_MODULES = {
    optics: [
      ['overview.html', 'Optics Foundations: Start Here'],
      ['01-light-and-matter.html', 'Lesson 1: Light & Matter'],
      ['02-reflection-and-tir.html', 'Lesson 2: Color, Reflection & Trapped Light'],
      ['03-lenses.html', 'Lesson 3: Bending Light — Lenses']
    ],
    solid_mechanics: [
      ['overview.html', 'Solid Mechanics Foundations: Start Here'],
      ['01-atoms-as-springs.html', 'Lesson 1: Atoms as Springs'],
      ['02-grains-and-boundaries.html', 'Lesson 2: Grains']
    ],
    foundations: [
      ['overview.html', 'Lab Foundations: Start Here']
    ]
  };
  function buildModules(folders, manifest) {
    const out = [];
    let order = 0;
    for (const folder of folders) {
      const files = manifest?.[folder]?.files
        ? manifest[folder].files.map(f => [f.name, f.title || f.name])
        : (STUB_MODULES[folder] || []);
      for (const [name, title] of files) {
        out.push({
          id: folder + '--' + name.replace(/\.html$/, ''),
          folder, htmlFile: name, title, order: order++, published: true
        });
      }
    }
    return out;
  }

  // V3.669 — the global teacherCatalog fixture: everything published, with a
  // few tags so the #/teach picker shows its metadata line. Same doc shape as
  // teacherCatalog/* (id === modules[].id).
  function buildCatalog(manifest) {
    const folders = manifest ? Object.keys(manifest) : Object.keys(STUB_MODULES);
    const out = [];
    let order = 0;
    for (const folder of folders) {
      for (const m of buildModules([folder], manifest)) {
        out.push({
          id: m.id, folder, file: m.htmlFile, title: m.title,
          published: true, order: order++,
          subjects: folder === 'optics' ? ['Physics'] : [],
          gradeLevels: folder === 'optics' ? ['9–12'] : [],
          description: folder === 'optics' ? 'Interactive optics lesson with simulations.' : ''
        });
      }
    }
    return out;
  }

  /* Every persona shares one cast; `setup` trims it down to the state
     that persona is meant to demonstrate. */
  function baseWorld(manifest) {
    const classes = [
      {
        id: CLASS_1, kind: 'teacher-class',
        title: 'Sunnyside High — McGhee Lab Modules',
        subtitle: 'Sunnyside High School', school: 'Sunnyside High School',
        semester: 'Fall 2026', description: 'Optics and solid mechanics for AP Physics.',
        ownerUid: TEACHER_UID, teacherUid: TEACHER_UID, teacherName: 'Dana Ruiz',
        grantedFolders: ['optics', 'solid_mechanics'],
        modules: buildModules(['optics', 'solid_mechanics'], manifest),
        enrollmentOpen: true, tabs: [], classAdminEmails: [],
        createdAt: daysAgo(40), updatedAt: daysAgo(3)
      },
      {
        id: CLASS_2, kind: 'teacher-class',
        title: 'Sunnyside High — Period 2 (Bioprinting)',
        subtitle: 'Sunnyside High School', school: 'Sunnyside High School',
        semester: 'Fall 2026', description: '',
        ownerUid: TEACHER_UID, teacherUid: TEACHER_UID, teacherName: 'Dana Ruiz',
        grantedFolders: ['foundations'],
        modules: buildModules(['foundations'], manifest),
        enrollmentOpen: false, tabs: [], classAdminEmails: [],
        createdAt: daysAgo(20), updatedAt: daysAgo(2)
      }
    ];

    const joinCodes = [
      { code: 'K7M4PQ', scheduleId: CLASS_1, teacherUid: TEACHER_UID, active: true, createdAt: daysAgo(40) },
      { code: 'XR2LT9', scheduleId: CLASS_1, teacherUid: TEACHER_UID, active: false, createdAt: daysAgo(55) },
      { code: 'R3TZ88', scheduleId: CLASS_2, teacherUid: TEACHER_UID, active: false, createdAt: daysAgo(20) }
    ];

    const enrollments = [];
    ROSTER_1.forEach((name, i) => {
      const uid = 'demo-stu-1-' + i;
      enrollments.push({
        id: CLASS_1 + '_' + uid, scheduleId: CLASS_1, studentUid: uid,
        studentName: name, studentEmail: name.toLowerCase().replace(/[^a-z]+/g, '.') + '@sunnysidehs.example',
        teacherUid: TEACHER_UID, joinCode: 'K7M4PQ', status: 'active', createdAt: daysAgo(30 - i)
      });
    });
    ROSTER_2.forEach((name, i) => {
      const uid = 'demo-stu-2-' + i;
      enrollments.push({
        id: CLASS_2 + '_' + uid, scheduleId: CLASS_2, studentUid: uid,
        studentName: name, studentEmail: name.toLowerCase().replace(/[^a-z]+/g, '.') + '@sunnysidehs.example',
        teacherUid: TEACHER_UID, joinCode: 'R3TZ88', status: 'active', createdAt: daysAgo(15 - i)
      });
    });
    // A teacher-removed student, so "view as" (V3.636) has a locked-out
    // student to preview and the roster shows the after-Remove state.
    enrollments.push({
      id: CLASS_1 + '_demo-stu-1-removed', scheduleId: CLASS_1, studentUid: 'demo-stu-1-removed',
      studentName: 'Jordan Blake', studentEmail: 'jordan.blake@sunnysidehs.example',
      teacherUid: TEACHER_UID, joinCode: 'K7M4PQ', status: 'removed', removedBy: 'teacher',
      createdAt: daysAgo(26)
    });
    // The signed-in student persona.
    enrollments.push({
      id: CLASS_1 + '_' + STUDENT_UID, scheduleId: CLASS_1, studentUid: STUDENT_UID,
      studentName: 'Miguel Alvarez', studentEmail: 'miguel.alvarez@sunnysidehs.example',
      teacherUid: TEACHER_UID, joinCode: 'K7M4PQ', status: 'active', createdAt: daysAgo(12)
    });

    // V3.669 — a class-wide due date + one per-student override, so the
    // #/teach modules/students tabs and the student class page each render a
    // populated state out of the box.
    if (classes[0].modules[1]) classes[0].modules[1].dueDate = daysFromNowISO(5);
    if (classes[0].modules[0]) {
      const marcus = enrollments.find(e => e.studentUid === 'demo-stu-1-1');
      if (marcus) marcus.moduleOverrides = { [classes[0].modules[0].id]: { hidden: true } };
    }

    // V3.671 — two published assignments (one due soon, one past-due) plus a
    // draft, and submissions in all three states: done, submitted-ungraded,
    // and graded — so the student card, gradebook, and notifications copy all
    // render populated out of the box.
    const assignments = [
      {
        id: 'demo-asg-1', scheduleId: CLASS_1, teacherUid: TEACHER_UID,
        title: 'Lens worksheet', description: 'Work through Lesson 3, then answer the ray-diagram questions.',
        dueDate: daysFromNowISO(3), points: 10, moduleKey: classes[0].modules[2]?.id || null,
        status: 'published', order: 0, createdAt: daysAgo(6), updatedAt: daysAgo(6)
      },
      {
        id: 'demo-asg-2', scheduleId: CLASS_1, teacherUid: TEACHER_UID,
        title: 'Reflection lab write-up', description: 'One paragraph: what surprised you about total internal reflection?',
        dueDate: daysFromNowISO(-2), points: 5, moduleKey: null,
        status: 'published', order: 1, createdAt: daysAgo(10), updatedAt: daysAgo(10)
      },
      {
        id: 'demo-asg-3', scheduleId: CLASS_1, teacherUid: TEACHER_UID,
        title: 'Springs quiz (draft)', description: '', dueDate: null, points: null, moduleKey: null,
        status: 'draft', order: 2, createdAt: daysAgo(1), updatedAt: daysAgo(1)
      }
    ];
    const submissions = [
      { // graded — the student persona sees a recorded outcome
        id: 'demo-asg-2_' + STUDENT_UID, assignmentId: 'demo-asg-2', scheduleId: CLASS_1,
        teacherUid: TEACHER_UID, studentUid: STUDENT_UID, studentName: 'Miguel Alvarez',
        status: 'submitted', text: 'The light just kept bouncing — I expected it to leak out at shallow angles but it never did.',
        submittedAt: daysAgo(3), updatedAt: daysAgo(2), lastEditedBy: STUDENT_UID,
        grade: { outcome: 'complete', score: 5, feedback: 'Nice observation — that “never leaks” is exactly the critical angle.', gradedAt: daysAgo(2), gradedBy: TEACHER_UID }
      },
      { // submitted, waiting on the teacher
        id: 'demo-asg-1_demo-stu-1-0', assignmentId: 'demo-asg-1', scheduleId: CLASS_1,
        teacherUid: TEACHER_UID, studentUid: 'demo-stu-1-0', studentName: 'Aaliyah Chen',
        status: 'submitted', text: 'Diagrams attached in my notebook — converging lens flips the image past f.',
        submittedAt: daysAgo(1), updatedAt: daysAgo(1), lastEditedBy: 'demo-stu-1-0'
      },
      { // plain mark-done
        id: 'demo-asg-1_demo-stu-1-1', assignmentId: 'demo-asg-1', scheduleId: CLASS_1,
        teacherUid: TEACHER_UID, studentUid: 'demo-stu-1-1', studentName: 'Marcus Webb',
        status: 'done', submittedAt: daysAgo(1), updatedAt: daysAgo(1), lastEditedBy: 'demo-stu-1-1'
      }
    ];

    // V3.672 — engagement fixtures: one keen student, one moderate (the
    // student persona), one who has gone quiet for 12 days — so the
    // Engagement tab renders every state including the quiet flag.
    const mods = classes[0].modules;
    function statFix(uid, name, lastActive, moduleMap) {
      return {
        id: CLASS_1 + '_' + uid, scheduleId: CLASS_1, teacherUid: TEACHER_UID,
        studentUid: uid, studentName: name, lastActiveAt: lastActive, modules: moduleMap
      };
    }
    const moduleStats = [];
    if (mods[0] && mods[1]) {
      moduleStats.push(statFix('demo-stu-1-0', 'Aaliyah Chen', daysAgo(0), {
        [mods[0].id]: { opens: 5, seconds: 2700, sections: { 's-intro': true, 's-sim': true, 's-wrap': true }, railCount: 4, lastOpenAt: daysAgo(0) },
        [mods[1].id]: { opens: 3, seconds: 1500, scrollPct: 85, lastOpenAt: daysAgo(1) }
      }));
      moduleStats.push(statFix(STUDENT_UID, 'Miguel Alvarez', daysAgo(2), {
        [mods[0].id]: { opens: 2, seconds: 900, sections: { 's-intro': true }, railCount: 4, lastOpenAt: daysAgo(2) }
      }));
      moduleStats.push(statFix('demo-stu-1-2', 'Priya Nair', daysAgo(12), {
        [mods[0].id]: { opens: 1, seconds: 240, scrollPct: 30, lastOpenAt: daysAgo(12) }
      }));
    }

    // V3.673 — engagement-hub fixtures: an approved listing with private
    // contact details, weekly + dated availability (plus one blocked date),
    // and requests in pending/confirmed states so both sides of the hub and
    // the admin tab render populated.
    const engageProfiles = [{
      id: TEACHER_UID, teacherUid: TEACHER_UID, displayName: 'Dana Ruiz',
      school: 'Sunnyside High School', schoolType: 'high-school', city: 'Tucson', gradeLevels: ['11', '12'],
      subjects: ['AP Physics'], classSize: 28,
      topics: ['bioprinting', 'careers in engineering', 'how research works'],
      activityTypes: ['guest-talk', 'demo', 'career-chat'],
      formats: ['at-school', 'virtual'],
      status: 'approved', updatedAt: daysAgo(8)
    }, {
      id: CC_TEACHER_UID, teacherUid: CC_TEACHER_UID, displayName: 'Ravi Menon',
      school: 'Desert Valley Community College', schoolType: 'community-college', city: 'Tucson',
      gradeLevels: ['college'], subjects: ['Intro Biology'], classSize: 32,
      topics: ['tissue engineering', 'transferring to a university'],
      activityTypes: ['guest-talk', 'career-chat'], formats: ['at-school', 'virtual'],
      status: 'approved', updatedAt: daysAgo(4)
    }];
    const engageContacts = {
      [TEACHER_UID]: {
        address: '1725 E Bilby Rd, Tucson AZ 85706', room: 'Building C, Room 214',
        phone: '(520) 555-0142', arrivalNotes: 'Check in at the front office; visitor parking is on the east side.'
      }
    };
    // V3.791 — opportunities: one thing the teacher wants, several dates
    // that would work. Presenters sign up for the opportunity and tick the
    // dates they could do; the teacher picks one when accepting.
    const TUE = [upcoming(2, 0), upcoming(2, 1), upcoming(2, 2)];
    const FRI = [upcoming(5, 2), upcoming(5, 3)];
    const THU = [upcoming(4, 0), upcoming(4, 1), upcoming(4, 2)];
    const at = (dates, s, e) => dates.map(date => ({ date, startTime: s, endTime: e }));
    const engageOpportunities = [
      {
        id: 'demo-opp-1', teacherUid: TEACHER_UID, title: 'Guest talk: how research actually works',
        activityTypes: ['guest-talk', 'demo'], formats: ['at-school', 'virtual'],
        topic: 'bioprinting, careers in engineering — anything hands-on',
        classContext: { grade: '11–12', subject: 'AP Physics', size: 28 },
        presentersWanted: 1, dates: at(TUE, '10:00', '10:50'), dateKeys: TUE,
        status: 'open', pendingCount: 1, acceptedCount: 0, timezone: 'America/Phoenix',
        createdAt: daysAgo(8), updatedAt: daysAgo(1)
      },
      {
        id: 'demo-opp-2', teacherUid: TEACHER_UID, title: 'Careers in engineering panel',
        activityTypes: ['career-chat'], formats: ['at-school'],
        topic: 'What engineers do all day, and how you got there',
        classContext: { grade: '11–12', subject: 'AP Physics', size: 28 },
        presentersWanted: 3, dates: at(FRI, '13:00', '14:30'), dateKeys: FRI,
        status: 'open', pendingCount: 0, acceptedCount: 1, bookedDate: FRI[0],
        acceptedRequestIds: ['demo-ereq-4'], timezone: 'America/Phoenix',
        createdAt: daysAgo(5), updatedAt: daysAgo(2)
      },
      {
        id: 'demo-opp-3', teacherUid: TEACHER_UID, title: 'Demo: lasers and light',
        activityTypes: ['demo'], formats: ['at-school'], topic: 'total internal reflection',
        classContext: { grade: '11–12', subject: 'AP Physics', size: 28 },
        presentersWanted: 1, dates: at([daysAgo(6).toISOString().slice(0, 10)], '10:00', '10:50'),
        dateKeys: [daysAgo(6).toISOString().slice(0, 10)],
        status: 'booked', pendingCount: 0, acceptedCount: 1, bookedDate: daysAgo(6).toISOString().slice(0, 10),
        acceptedRequestIds: ['demo-ereq-2'], timezone: 'America/Phoenix',
        createdAt: daysAgo(20), updatedAt: daysAgo(10)
      },
      {
        id: 'demo-opp-4', teacherUid: TEACHER_UID, title: 'Demo: printing a heart valve',
        activityTypes: ['demo'], formats: ['at-school'], topic: 'bioprinting',
        classContext: { grade: '11–12', subject: 'AP Physics', size: 26 },
        presentersWanted: 1, dates: at([daysAgo(13).toISOString().slice(0, 10)], '10:00', '10:50'),
        dateKeys: [daysAgo(13).toISOString().slice(0, 10)],
        status: 'booked', pendingCount: 0, acceptedCount: 1, bookedDate: daysAgo(13).toISOString().slice(0, 10),
        acceptedRequestIds: ['demo-ereq-3'], timezone: 'America/Phoenix',
        createdAt: daysAgo(30), updatedAt: daysAgo(20)
      },
      {
        id: 'demo-opp-cc1', teacherUid: CC_TEACHER_UID, title: 'Tissue engineering, for Intro Biology',
        activityTypes: ['guest-talk', 'career-chat'], formats: ['at-school', 'virtual'],
        topic: 'tissue engineering; transferring to a university',
        classContext: { grade: 'college', subject: 'Intro Biology', size: 32 },
        presentersWanted: 1, dates: at(THU, '18:00', '19:15'), dateKeys: THU,
        status: 'open', pendingCount: 0, acceptedCount: 0, timezone: 'America/Phoenix',
        createdAt: daysAgo(4), updatedAt: daysAgo(4)
      }
    ];
    const engageRequests = [
      {
        id: 'demo-ereq-1', opportunityId: 'demo-opp-1', opportunityTitle: 'Guest talk: how research actually works',
        teacherUid: TEACHER_UID,
        requesterUid: PRESENTER_UID, requesterName: 'Dr. Amara Okafor',
        requesterAffiliation: 'UofA Biomedical Engineering', requesterTitle: 'Associate Professor',
        requesterEmail: 'a.okafor@arizona.example',
        dates: [TUE[0], TUE[1]], okWithOthers: false,
        activityType: 'guest-talk', format: 'at-school', topic: 'How we 3D-print living tissue',
        message: 'I run the bioprinting core — happy to bring printed scaffolds the students can handle.',
        status: 'pending', createdAt: daysAgo(1), updatedAt: daysAgo(1)
      },
      {
        id: 'demo-ereq-2', opportunityId: 'demo-opp-3', opportunityTitle: 'Demo: lasers and light',
        teacherUid: TEACHER_UID,
        requesterUid: 'demo-pi-chen', requesterName: 'Dr. Wei Chen',
        requesterAffiliation: 'UofA Optical Sciences',
        requesterEmail: 'w.chen@arizona.example', dates: [daysAgo(6).toISOString().slice(0, 10)],
        date: daysAgo(6).toISOString().slice(0, 10),
        startTime: '10:00', endTime: '10:50', activityType: 'demo',
        format: 'at-school', topic: 'Lasers and total internal reflection',
        message: '', status: 'confirmed',
        location: engageContacts[TEACHER_UID], teacherNote: 'The class loved planning for this!',
        expectedStudents: 28, emailedAt: daysAgo(10),
        createdAt: daysAgo(12), updatedAt: daysAgo(10), decidedAt: daysAgo(10)
      },
      { // V3.787 — a visit that happened and hasn't been reviewed yet
        id: 'demo-ereq-3', opportunityId: 'demo-opp-4', opportunityTitle: 'Demo: printing a heart valve',
        teacherUid: TEACHER_UID,
        requesterUid: PRESENTER_UID, requesterName: 'Dr. Amara Okafor',
        requesterAffiliation: 'UofA Biomedical Engineering', requesterTitle: 'Associate Professor',
        requesterEmail: 'a.okafor@arizona.example', dates: [daysAgo(13).toISOString().slice(0, 10)],
        date: daysAgo(13).toISOString().slice(0, 10),
        startTime: '10:00', endTime: '10:50', activityType: 'demo',
        format: 'at-school', topic: 'Printing a heart valve',
        message: '', status: 'confirmed', location: engageContacts[TEACHER_UID],
        expectedStudents: 26, emailedAt: daysAgo(20),
        createdAt: daysAgo(24), updatedAt: daysAgo(20), decidedAt: daysAgo(20)
      },
      { // V3.791 — the first of three presenters accepted for the careers panel
        id: 'demo-ereq-4', opportunityId: 'demo-opp-2', opportunityTitle: 'Careers in engineering panel',
        teacherUid: TEACHER_UID,
        requesterUid: 'demo-pi-chen', requesterName: 'Dr. Wei Chen',
        requesterAffiliation: 'UofA Optical Sciences', requesterTitle: 'Research Scientist',
        requesterEmail: 'w.chen@arizona.example', dates: [FRI[0], FRI[1]], okWithOthers: true,
        date: FRI[0], startTime: '13:00', endTime: '14:30',
        activityType: 'career-chat', format: 'at-school', topic: 'From optics PhD to a startup',
        message: 'Happy to be one of several.', status: 'confirmed',
        location: engageContacts[TEACHER_UID], expectedStudents: 28, emailedAt: daysAgo(1),
        createdAt: daysAgo(3), updatedAt: daysAgo(2), decidedAt: daysAgo(2)
      }
    ];
    const engagePresenters = [
      { id: PRESENTER_UID, name: 'Dr. Amara Okafor', affiliation: 'UofA Biomedical Engineering',
        title: 'Associate Professor', email: 'a.okafor@arizona.example', phone: '',
        bring: 'I run the bioprinting core and can bring printed scaffolds students can handle.',
        updatedAt: daysAgo(30) },
      { id: 'demo-pi-chen', name: 'Dr. Wei Chen', affiliation: 'UofA Optical Sciences',
        title: 'Research Scientist', email: 'w.chen@arizona.example', phone: '',
        bring: 'Laser and fibre-optic demos.', updatedAt: daysAgo(40) }
    ];
    const engageReviews = [
      { id: 'demo-ereq-2', requesterUid: 'demo-pi-chen', teacherUid: TEACHER_UID,
        requesterName: 'Dr. Wei Chen', visitDate: daysAgo(6).toISOString().slice(0, 10),
        rating: 5, engagement: 4, studentsReached: 27, wouldReturn: 'yes',
        wentWell: 'They had questions ready. The laser-pointer-in-jello demo landed.',
        improve: 'Forty minutes was tight; next time I would cut the slides.',
        createdAt: daysAgo(5), updatedAt: daysAgo(5) }
    ];

    return {
      catalog: buildCatalog(manifest),
      assignments,
      submissions,
      moduleStats,
      engageProfiles,
      engageContacts,
      engageOpportunities,
      engageRequests,
      engagePresenters,
      engageReviews,
      classes,
      joinCodes,
      enrollments,
      requests: [
        {
          id: 'demo-req-1', teacherUid: TEACHER_UID, teacherName: 'Dana Ruiz',
          teacherEmail: 'dana.ruiz@sunnysidehs.example', school: 'Sunnyside High School',
          schoolCity: 'Tucson', schoolState: 'AZ', gradeLevel: '11–12', classSize: 28,
          subjectArea: 'AP Physics', requestedFolders: ['optics', 'solid_mechanics'],
          message: 'We run a 3-week optics unit in October and would love the interactive lessons.',
          status: 'approved', scheduleId: CLASS_1, createdAt: daysAgo(45)
        }
      ],
      reviews: [
        {
          id: 'demo-rev-1', authorUid: TEACHER_UID, authorName: 'Dana Ruiz', authorRole: 'teacher',
          scheduleId: CLASS_1, teacherUid: TEACHER_UID, school: 'Sunnyside High School',
          rating: 5, text: 'The lens lesson did in 40 minutes what my textbook unit never managed. My students asked to keep going.',
          status: 'approved', featured: true, createdAt: daysAgo(9)
        },
        {
          id: 'demo-rev-2', authorUid: 'demo-stu-1-0', authorName: 'Aaliyah Chen', authorRole: 'student',
          scheduleId: CLASS_1, teacherUid: TEACHER_UID, school: 'Sunnyside High School',
          rating: 5, text: 'I finally understand why metals bend and glass just snaps.',
          status: 'approved', featured: true, createdAt: daysAgo(7)
        },
        {
          id: 'demo-rev-3', authorUid: 'demo-stu-1-1', authorName: 'Marcus Webb', authorRole: 'student',
          scheduleId: CLASS_1, teacherUid: TEACHER_UID, school: 'Sunnyside High School',
          rating: 4, text: 'Good, but the third simulation was slow on a Chromebook.',
          status: 'pending', featured: false, createdAt: daysAgo(2)
        }
      ],
      profiles: [
        {
          id: TEACHER_UID, uid: TEACHER_UID, name: 'Dana Ruiz', school: 'Sunnyside High School',
          subjectArea: 'AP Physics', status: 'approved',
          blurb: 'I teach AP Physics and run the robotics club at Sunnyside High in Tucson.',
          photo: null, updatedAt: daysAgo(10), approvedAt: daysAgo(8)
        }
      ]
    };
  }

  /* ================================================================
     PERSONAS
     ================================================================ */
  const PERSONAS = [
    {
      id: 'visitor-signedout', group: 'Outside visitor', label: 'Signed-out visitor',
      note: 'Lands on a class page from a link a teacher shared. Should get the Google sign-in gate.',
      signedOut: true, uid: null, open: '#/classes/' + CLASS_1,
      profile: {},
      setup: () => {}
    },
    {
      id: 'guest-new', group: 'Outside visitor', label: 'Brand-new sign-in (guest)',
      note: 'Just signed in with Google, no profile yet. V3.680: sees ONLY the profile card — no teacher/student CTAs (teacher onboarding lives on #/teachers; students join via their class link).',
      uid: GUEST_UID, open: '#/dashboard',
      profile: { uid: GUEST_UID, name: '', email: 'sam.q@gmail.example', role: 'guest', category: 'guest', bio: '', photo: null },
      setup: () => {}
    },
    {
      id: 'teacher-fresh', group: 'Teacher', label: 'Nothing requested yet',
      note: 'Self-identified as a teacher. Empty class list, blank request form (module-set checkboxes come from the live manifest), empty public profile.',
      uid: TEACHER_UID, open: '#/dashboard',
      profile: teacherProfileFixture(),
      setup: (w) => { w.classes = []; w.joinCodes = []; w.enrollments = []; w.requests = []; w.reviews = []; w.profiles = []; w.assignments = []; w.submissions = []; w.moduleStats = []; w.engageProfiles = []; w.engageOpportunities = []; w.engageRequests = []; w.engageContacts = {}; w.engagePresenters = []; w.engageReviews = []; }
    },
    {
      id: 'teacher-pending', group: 'Teacher', label: 'Request awaiting review',
      note: 'The state a teacher sits in while you decide. Pending chip, “being reviewed” copy, Withdraw button, no form.',
      uid: TEACHER_UID, open: '#/dashboard',
      profile: teacherProfileFixture(),
      setup: (w) => {
        w.classes = []; w.joinCodes = []; w.enrollments = []; w.reviews = []; w.profiles = [];
        w.assignments = []; w.submissions = []; w.moduleStats = []; w.engageProfiles = []; w.engageOpportunities = []; w.engageRequests = []; w.engageContacts = {}; w.engagePresenters = []; w.engageReviews = [];
        w.requests = [Object.assign({}, w.requests[0], {
          id: 'demo-req-pending', status: 'pending', scheduleId: null, createdAt: daysAgo(4)
        })];
      }
    },
    {
      id: 'teacher-denied', group: 'Teacher', label: 'Request denied',
      note: 'Checks that your deny reason actually reaches the teacher, and that they get a fresh form to try again.',
      uid: TEACHER_UID, open: '#/dashboard',
      profile: teacherProfileFixture(),
      setup: (w) => {
        w.classes = []; w.joinCodes = []; w.enrollments = []; w.reviews = []; w.profiles = [];
        w.assignments = []; w.submissions = []; w.moduleStats = []; w.engageProfiles = []; w.engageOpportunities = []; w.engageRequests = []; w.engageContacts = {}; w.engagePresenters = []; w.engageReviews = [];
        w.requests = [Object.assign({}, w.requests[0], {
          id: 'demo-req-denied', status: 'denied', scheduleId: null, createdAt: daysAgo(6),
          denyReason: 'We only support the optics set this semester — please re-request in January.'
        })];
      }
    },
    {
      id: 'teacher-live', group: 'Teacher', label: 'Approved, no students yet',
      note: 'The first hour after you approve: one class, a fresh join code, an empty roster, profile still a draft. The most common real state.',
      uid: TEACHER_UID, open: '#/dashboard',
      profile: teacherProfileFixture(),
      setup: (w) => {
        w.classes = w.classes.filter(c => c.id === CLASS_1);
        w.joinCodes = w.joinCodes.filter(j => j.scheduleId === CLASS_1 && j.active);
        w.enrollments = [];
        w.reviews = [];
        w.assignments = []; w.submissions = []; w.moduleStats = []; w.engageProfiles = []; w.engageOpportunities = []; w.engageRequests = []; w.engageContacts = {}; w.engagePresenters = []; w.engageReviews = [];
        w.profiles = [Object.assign({}, w.profiles[0], { status: 'draft', approvedAt: null })];
      }
    },
    {
      id: 'teacher-busy', group: 'Teacher', label: 'Approved, 2 classes, 15 students',
      note: 'A full teacher: two classes (10 + 5 students), one join code disabled, an approved public profile, and reviews in two states. Opens the four-tab teaching hub (V3.769) — Dashboard, Students, Modules, Engagement — with the class switcher live.',
      uid: TEACHER_UID, open: '#/teach',
      profile: teacherProfileFixture(),
      setup: () => {}
    },
    {
      id: 'teacher-engage', group: 'Teacher', label: 'Engagement hub — visits & requests',
      note: 'The hub side of teaching: an approved listing with private location details, two open opportunities (one a three-presenter panel with one presenter already accepted), one sign-up waiting on you, and two past visits (one reviewed).',
      uid: TEACHER_UID, open: '#/engage',
      profile: teacherProfileFixture(),
      setup: () => {}
    },
    {
      id: 'teacher-accepted', group: 'Teacher', label: 'Accepted a visit, email not sent',
      note: 'V3.787: Dr. Okafor’s request is accepted (28 students, location shared) but the teacher has not sent the confirmation email yet, so the Dashboard and step 7 both ask for it.',
      uid: TEACHER_UID, open: '#/teach/' + CLASS_1 + '/engagement',
      profile: teacherProfileFixture(),
      setup: (w) => {
        const r = w.engageRequests.find(x => x.id === 'demo-ereq-1');
        Object.assign(r, { status: 'confirmed', date: r.dates[0], startTime: '10:00', endTime: '10:50',
          expectedStudents: 28, location: w.engageContacts[TEACHER_UID], decidedAt: daysAgo(0) });
        const o = w.engageOpportunities.find(x => x.id === r.opportunityId);
        Object.assign(o, { status: 'booked', bookedDate: r.date, acceptedRequestIds: [r.id], pendingCount: 0, acceptedCount: 1 });
      }
    },
    {
      id: 'presenter-new', group: 'Presenter', label: 'First visit to the presenter link',
      note: 'V3.785: signed in through mcgheelab.com/#/presenters with no presenter profile yet. The “About you” card comes first; openings from two schools (a high school and a community college) sit behind it.',
      uid: PRESENTER_NEW_UID, open: '#/presenters',
      profile: { uid: PRESENTER_NEW_UID, name: 'Jordan Blake', email: 'jordan.blake@pima.example', role: 'guest', category: 'guest', bio: '', photo: null },
      setup: () => {}
    },
    {
      id: 'presenter-active', group: 'Presenter', label: 'Visits booked, one review due',
      note: 'V3.785/787: Dr. Okafor has a request waiting on the teacher and a visit two weeks ago that still needs a review.',
      uid: PRESENTER_UID, open: '#/presenters',
      profile: { uid: PRESENTER_UID, name: 'Dr. Amara Okafor', email: 'a.okafor@arizona.example', role: 'guest', category: 'guest', bio: '', photo: null },
      setup: () => {}
    },
    {
      id: 'student-new', group: 'Student', label: 'Not in a class yet',
      note: 'Has the join card and nothing else. Try a bad code (BADBAD), then the real one: K7M4PQ.',
      uid: STUDENT_UID, open: '#/dashboard',
      profile: studentProfileFixture(),
      setup: (w) => { w.enrollments = w.enrollments.filter(e => e.studentUid !== STUDENT_UID); w.reviews = []; }
    },
    {
      id: 'student-enrolled', group: 'Student', label: 'Enrolled in a class',
      note: 'My Classes resolves the class title, “Open modules” works, and the review form appears.',
      uid: STUDENT_UID, open: '#/dashboard',
      profile: studentProfileFixture(),
      setup: (w) => { w.reviews = w.reviews.filter(r => r.authorUid !== STUDENT_UID); }
    },
    {
      id: 'student-reviewed', group: 'Student', label: 'Review awaiting moderation',
      note: 'Confirms a student can see their own unpublished review and edit it while it waits.',
      uid: STUDENT_UID, open: '#/dashboard',
      profile: studentProfileFixture(),
      setup: (w) => {
        w.reviews.push({
          id: 'demo-rev-mine', authorUid: STUDENT_UID, authorName: 'Miguel Alvarez',
          authorRole: 'student', scheduleId: CLASS_1, teacherUid: TEACHER_UID,
          school: 'Sunnyside High School', rating: 5,
          text: 'The trapped-light demo was my favorite part of the whole semester.',
          status: 'pending', featured: false, createdAt: daysAgo(1)
        });
      }
    },
    {
      id: 'student-removed', group: 'Student', label: 'Removed from the class',
      note: 'After a teacher clicks Remove. Dashboard shows no classes; the class page falls back to the code gate.',
      uid: STUDENT_UID, open: '#/classes/' + CLASS_1,
      profile: studentProfileFixture(),
      setup: (w) => {
        const mine = w.enrollments.find(e => e.studentUid === STUDENT_UID);
        if (mine) mine.status = 'removed';
        w.reviews = w.reviews.filter(r => r.authorUid !== STUDENT_UID);
      }
    }
  ];

  function teacherProfileFixture() {
    return {
      uid: TEACHER_UID, name: 'Dana Ruiz', email: 'dana.ruiz@sunnysidehs.example',
      role: 'guest', category: 'teacher',
      bio: 'AP Physics teacher, Sunnyside High School (Tucson, AZ).', photo: null
    };
  }
  function studentProfileFixture() {
    return {
      uid: STUDENT_UID, name: 'Miguel Alvarez', email: 'miguel.alvarez@sunnysidehs.example',
      role: 'guest', category: 'student', bio: '', photo: null
    };
  }

  /* ================================================================
     STATE
     ================================================================ */
  const state = { personaId: null, persona: null, world: null, log: [], manifest: null };

  function logAction(kind, detail) {
    state.log.unshift({ kind, detail, at: new Date() });
    if (state.log.length > 60) state.log.pop();
    updateBannerLog();
  }

  function note(msg) {
    logAction('blocked', msg);
    const el = document.getElementById('tcd-toast');
    if (!el) return;
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(note._t);
    note._t = setTimeout(() => { el.hidden = true; }, 4000);
  }

  function buildWorld() {
    const w = baseWorld(state.manifest);
    state.persona.setup(w);
    return w;
  }

  async function refreshModulesFromManifest() {
    if (state.manifest) return;
    try {
      const res = await fetch('modules/manifest.json');
      if (!res.ok) return;
      state.manifest = (await res.json()).folders || null;
      if (state.manifest && state.world) {
        for (const c of state.world.classes) c.modules = buildModules(c.grantedFolders || [], state.manifest);
        state.world.catalog = buildCatalog(state.manifest);
      }
    } catch (e) { /* stub modules are fine */ }
  }

  /* ================================================================
     DEMO DATA LAYER — same interface as teacher-classes.js TC_DB.
     Reads answer from the in-memory world; writes mutate it and append
     to the action log. Nothing reaches Firestore.
     ================================================================ */
  const DEMO_DB = {
    /* ---- class requests ---- */
    async createRequest(data) {
      const id = 'demo-req-' + Date.now();
      state.world.requests.unshift(Object.assign({ id, createdAt: new Date() }, data));
      logAction('write', `classRequests/${id} created — status pending, folders: ${(data.requestedFolders || []).join(', ')}`);
      return id;
    },
    async myRequests(uid) {
      return state.world.requests.filter(r => r.teacherUid === uid)
        .slice().sort((a, b) => b.createdAt - a.createdAt);
    },
    async withdrawRequest(id) {
      state.world.requests = state.world.requests.filter(r => r.id !== id);
      logAction('write', `classRequests/${id} deleted (withdrawn)`);
    },

    /* ---- teacher classes ---- */
    async myTeacherClasses(uid) {
      return state.world.classes.filter(c => c.ownerUid === uid && c.kind === 'teacher-class');
    },
    async getSchedule(id) {
      return state.world.classes.find(c => c.id === id) || null;
    },
    async setEnrollmentOpen(scheduleId, open) {
      const c = state.world.classes.find(x => x.id === scheduleId);
      if (c) c.enrollmentOpen = !!open;
      logAction('write', `schedules/${scheduleId}.enrollmentOpen = ${!!open}`);
    },

    /* ---- global module catalog (V3.669) ---- */
    async publishedCatalog() {
      return state.world.catalog.filter(c => c.published)
        .slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    },
    async saveClassModules(scheduleId, modules) {
      const c = state.world.classes.find(x => x.id === scheduleId);
      if (c) c.modules = modules;
      logAction('write', `schedules/${scheduleId}.modules — ${modules.length} entries saved`);
    },
    async setModuleOverride(enrollmentId, moduleId, override) {
      const e = state.world.enrollments.find(x => x.id === enrollmentId);
      if (e) {
        e.moduleOverrides = e.moduleOverrides || {};
        if (override) e.moduleOverrides[moduleId] = override;
        else delete e.moduleOverrides[moduleId];
      }
      logAction('write', `enrollments/${enrollmentId}.moduleOverrides.${moduleId} = ` +
        (override ? JSON.stringify(override) : '(deleted)'));
    },

    /* ---- assignments + submissions (V3.671) ---- */
    async assignmentsForTeacher(uid) {
      return state.world.assignments.filter(a => a.teacherUid === uid);
    },
    async assignmentsForStudent(scheduleId) {
      return state.world.assignments
        .filter(a => a.scheduleId === scheduleId && (a.status === 'published' || a.status === 'closed'))
        .slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    },
    async saveAssignment(id, data) {
      if (id) {
        const a = state.world.assignments.find(x => x.id === id);
        if (a) Object.assign(a, data, { updatedAt: new Date() });
        logAction('write', `assignments/${id} updated — ${Object.keys(data).join(', ')}`);
        return id;
      }
      const newId = 'demo-asg-' + Date.now();
      state.world.assignments.push(Object.assign({ id: newId, createdAt: new Date(), updatedAt: new Date() }, data));
      logAction('write', `assignments/${newId} created — status ${data.status}` +
        (data.status === 'published' ? ' (would notify enrolled students)' : ''));
      return newId;
    },
    async deleteAssignment(id) {
      state.world.assignments = state.world.assignments.filter(a => a.id !== id);
      logAction('write', `assignments/${id} deleted`);
    },
    submissionId(assignmentId, uid) { return assignmentId + '_' + uid; },
    async mySubmission(assignmentId, uid) {
      return state.world.submissions.find(s => s.assignmentId === assignmentId && s.studentUid === uid) || null;
    },
    async submitAssignment(assignment, student, patch) {
      const id = assignment.id + '_' + student.uid;
      let s = state.world.submissions.find(x => x.id === id);
      if (!s) {
        s = {
          id, assignmentId: assignment.id, scheduleId: assignment.scheduleId,
          teacherUid: assignment.teacherUid, studentUid: student.uid,
          studentName: student.name || ''
        };
        state.world.submissions.push(s);
      }
      Object.assign(s, patch, { submittedAt: new Date(), updatedAt: new Date(), lastEditedBy: student.uid });
      logAction('write', `submissions/${id} — status ${patch.status} (would notify the teacher)`);
      return id;
    },
    async submissionsForTeacher(uid) {
      return state.world.submissions.filter(s => s.teacherUid === uid);
    },
    async gradeSubmission(submissionId, grade) {
      const s = state.world.submissions.find(x => x.id === submissionId);
      if (s) { s.grade = grade; s.updatedAt = new Date(); }
      logAction('write', `submissions/${submissionId}.grade = ${grade.outcome}` +
        (grade.score != null ? ` (${grade.score})` : '') + ' (would notify the student)');
    },

    /* ---- module engagement (V3.672) ---- */
    statsId(scheduleId, uid) { return scheduleId + '_' + uid; },
    async statsForTeacher(uid) {
      return state.world.moduleStats.filter(s => s.teacherUid === uid);
    },
    async recordEngagement(scheduleId, student, patch) {
      const id = scheduleId + '_' + student.uid;
      let st = state.world.moduleStats.find(x => x.id === id);
      if (!st) {
        st = {
          id, scheduleId, teacherUid: student.teacherUid,
          studentUid: student.uid, studentName: student.name || '', modules: {}
        };
        state.world.moduleStats.push(st);
      }
      const m = st.modules[patch.moduleId] = st.modules[patch.moduleId] || {};
      if (patch.opens) { m.opens = (m.opens || 0) + patch.opens; m.lastOpenAt = new Date(); }
      if (patch.seconds) m.seconds = (m.seconds || 0) + patch.seconds;
      if (patch.sections) {
        m.sections = m.sections || {};
        for (const sid of patch.sections) m.sections[sid] = true;
      }
      if (patch.railCount != null) m.railCount = patch.railCount;
      if (patch.scrollPct != null) m.scrollPct = patch.scrollPct;
      st.lastActiveAt = new Date();
      logAction('write', `moduleStats/${id}.modules.${patch.moduleId} — ` +
        Object.keys(patch).filter(k => k !== 'moduleId').join(', '));
    },

    /* ---- join codes ---- */
    async getJoinCode(code) {
      return state.world.joinCodes.find(j => j.code === code) || null;
    },
    async myJoinCodes(uid) {
      return state.world.joinCodes.filter(j => j.teacherUid === uid);
    },
    async createJoinCode(scheduleId, teacherUid) {
      const code = fakeCode();
      state.world.joinCodes.push({ code, scheduleId, teacherUid, active: true, createdAt: new Date() });
      logAction('write', `joinCodes/${code} created — active, class ${scheduleId}`);
      return code;
    },
    async deactivateCode(code) {
      const j = state.world.joinCodes.find(x => x.code === code);
      if (j) j.active = false;
      logAction('write', `joinCodes/${code}.active = false`);
    },

    /* ---- enrollments ---- */
    enrollmentId(scheduleId, uid) { return scheduleId + '_' + uid; },
    async getEnrollment(scheduleId, uid) {
      return state.world.enrollments.find(e => e.scheduleId === scheduleId && e.studentUid === uid) || null;
    },
    async rosterForTeacher(uid) {
      return state.world.enrollments.filter(e => e.teacherUid === uid);
    },
    async myEnrollments(uid) {
      return state.world.enrollments.filter(e => e.studentUid === uid);
    },
    async setEnrollmentStatus(enrollmentId, status, joinCode) {
      const e = state.world.enrollments.find(x => x.id === enrollmentId);
      if (e) { e.status = status; if (joinCode) e.joinCode = joinCode; }
      logAction('write', `enrollments/${enrollmentId}.status = ${status}` +
        (joinCode ? ` (code ${joinCode})` : ''));
    },
    async removeStudent(enrollmentId) {
      const e = state.world.enrollments.find(x => x.id === enrollmentId);
      if (e) { e.status = 'removed'; e.removedBy = 'teacher'; }
      logAction('write', `enrollments/${enrollmentId} — status removed, removedBy teacher`);
    },
    async createEnrollment(scheduleId, uid, data) {
      const id = scheduleId + '_' + uid;
      state.world.enrollments.push(Object.assign(
        { id, scheduleId, studentUid: uid, createdAt: new Date() }, data));
      logAction('write', `enrollments/${id} created — joined with code ${data.joinCode}`);
    },
    async setUserCategory(uid, category) {
      if (state.persona.profile) state.persona.profile.category = category;
      logAction('write', `users/${uid}.category = ${category}`);
    },
    async linkStudentToTeacher(uid, teacherUid, school) {
      const p = state.persona.profile;
      if (p) {
        p.category = 'student';
        p.teacherUids = [...new Set([...(p.teacherUids || []), teacherUid])];
        if (school) p.studentSchool = school;
      }
      logAction('write', `users/${uid} — category student, teacherUids += ${teacherUid}`);
    },

    /* ---- engagement hub (V3.673) ---- */
    async getEngageProfile(uid) {
      return state.world.engageProfiles.find(p => p.id === uid) || null;
    },
    async saveEngageProfile(uid, data, submit) {
      const status = submit ? 'pending' : 'draft';
      const existing = state.world.engageProfiles.find(p => p.id === uid);
      if (existing) Object.assign(existing, data, { status, updatedAt: new Date() });
      else state.world.engageProfiles.push(Object.assign({ id: uid, teacherUid: uid }, data, { status, updatedAt: new Date() }));
      logAction('write', `engageProfiles/${uid} saved — status ${status}`);
    },
    async approvedEngageProfiles() {
      return state.world.engageProfiles.filter(p => p.status === 'approved');
    },
    async getEngageContact(uid) {
      return state.world.engageContacts[uid] || null;
    },
    async saveEngageContact(uid, data) {
      state.world.engageContacts[uid] = Object.assign(state.world.engageContacts[uid] || {}, data);
      logAction('write', `engageProfiles/${uid}/private/contact saved (owner+admin only)`);
    },
    /* ---- opportunities (V3.791) ---- */
    async myOpportunities(uid) {
      return state.world.engageOpportunities.filter(o => o.teacherUid === uid);
    },
    async openOpportunities() {
      return state.world.engageOpportunities.filter(o => o.status === 'open');
    },
    async saveOpportunity(id, data) {
      if (Array.isArray(data.dates)) data.dateKeys = data.dates.map(d => d.date);
      if (id) {
        const o = state.world.engageOpportunities.find(x => x.id === id);
        if (o) Object.assign(o, data, { updatedAt: new Date() });
        logAction('write', `engageOpportunities/${id} updated${data.status ? ' — status ' + data.status : ''}`);
        return id;
      }
      const newId = 'demo-opp-' + Date.now();
      state.world.engageOpportunities.push(Object.assign(
        { id: newId, pendingCount: 0, acceptedCount: 0, createdAt: new Date(), updatedAt: new Date() }, data));
      logAction('write', `engageOpportunities/${newId} created — "${data.title}", ${(data.dates || []).length} dates`);
      return newId;
    },
    async deleteOpportunity(id) {
      state.world.engageOpportunities = state.world.engageOpportunities.filter(o => o.id !== id);
      logAction('write', `engageOpportunities/${id} deleted`);
    },
    // What functions/engage-notify.js does in production: recount a
    // opportunity's pending / accepted requests after any request write.
    _recount(opportunityId) {
      const o = state.world.engageOpportunities.find(x => x.id === opportunityId);
      if (!o) return;
      const rs = state.world.engageRequests.filter(r => r.opportunityId === opportunityId);
      o.pendingCount = rs.filter(r => r.status === 'pending').length;
      o.acceptedCount = rs.filter(r => r.status === 'confirmed').length;
    },
    async createEngageRequest(data) {
      const id = 'demo-ereq-' + Date.now();
      state.world.engageRequests.push(Object.assign({ id, status: 'pending', createdAt: new Date(), updatedAt: new Date() }, data));
      this._recount(data.opportunityId);
      logAction('write', `engageRequests/${id} created — pending (would notify the teacher + admins; the function recounts the opportunity)`);
      return id;
    },
    async engageRequestsForTeacher(uid) {
      return state.world.engageRequests.filter(r => r.teacherUid === uid);
    },
    async engageRequestsForRequester(uid) {
      return state.world.engageRequests.filter(r => r.requesterUid === uid);
    },
    async decideEngageRequest(id, status, extras) {
      const r = state.world.engageRequests.find(x => x.id === id);
      if (r) Object.assign(r, extras || {}, { status, decidedAt: new Date(), updatedAt: new Date() });
      if (r) this._recount(r.opportunityId);
      logAction('write', `engageRequests/${id}.status = ${status}` +
        (extras && extras.location ? ' (location shared with the requester)' : '') +
        ' (would notify the requester)');
    },
    async cancelEngageRequest(id) {
      const r = state.world.engageRequests.find(x => x.id === id);
      if (r) { r.status = 'cancelled'; r.updatedAt = new Date(); this._recount(r.opportunityId); }
      logAction('write', `engageRequests/${id}.status = cancelled`);
    },
    async myEngageCaps() { return ['engage:browse', 'engage:request']; },

    /* ---- presenters + visit follow-through (V3.785-787) ---- */
    async getPresenter(uid) {
      return state.world.engagePresenters.find(p => p.id === uid) || null;
    },
    async savePresenter(uid, data) {
      const existing = state.world.engagePresenters.find(p => p.id === uid);
      if (existing) Object.assign(existing, data, { updatedAt: new Date() });
      else state.world.engagePresenters.push(Object.assign({ id: uid }, data, { updatedAt: new Date() }));
      logAction('write', `engagePresenters/${uid} saved`);
    },
    async markEngageEmailed(id) {
      const r = state.world.engageRequests.find(x => x.id === id);
      if (r) { r.emailedAt = new Date(); r.updatedAt = new Date(); }
      logAction('write', `engageRequests/${id}.emailedAt set (teacher opened the confirmation email)`);
    },
    async reviewsForRequester(uid) {
      return state.world.engageReviews.filter(r => r.requesterUid === uid);
    },
    async reviewsForTeacher(uid) {
      return state.world.engageReviews.filter(r => r.teacherUid === uid);
    },
    async saveEngageReview(reqId, data, isNew) {
      const existing = state.world.engageReviews.find(r => r.id === reqId);
      if (existing) Object.assign(existing, data, { updatedAt: new Date() });
      else state.world.engageReviews.push(Object.assign({ id: reqId, createdAt: new Date() }, data, { updatedAt: new Date() }));
      logAction('write', `engageReviews/${reqId} ${isNew ? 'created' : 'updated'} (would notify the teacher + admins)`);
    },

    /* ---- reviews ---- */
    async myReviews(uid) {
      return state.world.reviews.filter(r => r.authorUid === uid);
    },
    async approvedReviews(limit) {
      return state.world.reviews.filter(r => r.status === 'approved')
        .slice().sort((a, b) => b.createdAt - a.createdAt).slice(0, limit || 12);
    },
    async submitReview(data) {
      const id = 'demo-rev-' + Date.now();
      state.world.reviews.unshift(Object.assign(
        { id, status: 'pending', featured: false, createdAt: new Date() }, data));
      logAction('write', `reviews/${id} created — ${data.rating}★, status pending`);
      return id;
    },
    async updateReview(id, data) {
      const r = state.world.reviews.find(x => x.id === id);
      if (r) Object.assign(r, data, { status: 'pending' });
      logAction('write', `reviews/${id} updated — back to pending for re-moderation`);
    },

    /* ---- teacher public profiles ---- */
    async getTeacherProfile(uid) {
      return state.world.profiles.find(p => p.id === uid) || null;
    },
    async saveTeacherProfile(uid, data, submit) {
      const status = submit ? 'pending' : 'draft';
      const existing = state.world.profiles.find(p => p.id === uid);
      if (existing) Object.assign(existing, data, { status, updatedAt: new Date() });
      else state.world.profiles.push(Object.assign({ id: uid, uid }, data, { status, updatedAt: new Date() }));
      logAction('write', `teacherProfiles/${uid} saved — status ${status}`);
    },
    async approvedTeacherProfiles() {
      return state.world.profiles.filter(p => p.status === 'approved');
    }
  };

  /* ================================================================
     PUBLIC API (consumed by teacher-classes / user-system /
     class-builder / app.js)
     ================================================================ */
  const TC_DEMO = {
    get active() { return !!state.persona; },
    get personaId() { return state.personaId; },
    get persona() { return state.persona; },
    get uid() { return state.persona?.uid || null; },
    get profile() { return state.persona?.profile || {}; },
    get signedOut() { return !!state.persona?.signedOut; },
    get db() { return DEMO_DB; },
    get log() { return state.log; },
    note,

    /** class-builder's resolveSchedule hook — demo class ids only. */
    schedule(id) {
      if (!state.persona) return null;
      return state.world?.classes.find(c => c.id === id) || null;
    },

    /** Route a write that would normally hit the real profile doc. */
    interceptProfileWrite(what) {
      logAction('write', what + ' (demo — not saved)');
      note('Demo preview: ' + what + ' was not saved.');
    },

    start(personaId) {
      const p = PERSONAS.find(x => x.id === personaId);
      if (!p) return false;
      state.personaId = p.id;
      state.persona = p;
      // Re-clone the profile so edits in one session don't leak into the next.
      p.profile = p.id.startsWith('teacher') ? teacherProfileFixture()
        : p.id.startsWith('student') ? studentProfileFixture()
        : p.profile;
      state.world = buildWorld();
      state.log = [];
      try { sessionStorage.setItem(SS_KEY, p.id); } catch (e) {}
      document.body.classList.add('tcd-active');
      refreshModulesFromManifest();
      logAction('start', `demo started as “${p.label}”`);
      return true;
    },

    reset() {
      if (!state.persona) return;
      state.world = buildWorld();
      state.log = [];
      logAction('start', 'fixture data reset');
    },

    stop() {
      state.personaId = null; state.persona = null; state.world = null; state.log = [];
      try { sessionStorage.removeItem(SS_KEY); } catch (e) {}
      document.body.classList.remove('tcd-active');
    },

    /* ---- banner ---- */
    mountBanner(viewEl) {
      if (!state.persona || !viewEl) return;
      const p = state.persona;
      const strip = document.createElement('div');
      strip.className = 'tcd-banner';
      strip.innerHTML = `
        <div class="tcd-banner-row">
          <span class="tcd-badge">DEMO</span>
          <span class="tcd-viewing">Viewing as <strong>${esc(p.label)}</strong></span>
          <select id="tcd-switch" aria-label="Switch demo persona">
            ${[...new Set(PERSONAS.map(x => x.group))].map(g => `
              <optgroup label="${esc(g)}">
                ${PERSONAS.filter(x => x.group === g).map(x =>
                  `<option value="${esc(x.id)}"${x.id === p.id ? ' selected' : ''}>${esc(x.label)}</option>`).join('')}
              </optgroup>`).join('')}
          </select>
          <a class="tcd-link" href="#/demo">All personas</a>
          <button type="button" class="tcd-btn" id="tcd-reset">↻ Reset data</button>
          <button type="button" class="tcd-btn" id="tcd-log-toggle">Actions (<span id="tcd-log-count">${state.log.length}</span>)</button>
          <button type="button" class="tcd-btn tcd-btn-exit" id="tcd-exit">✕ Exit demo</button>
        </div>
        <p class="tcd-caveat">Fake data, nothing saved. You are still signed in as admin, so this shows layout and wiring — <strong>not</strong> permissions.</p>
        <div class="tcd-log" id="tcd-log" hidden></div>
        <div class="tcd-toast" id="tcd-toast" hidden></div>`;
      viewEl.insertBefore(strip, viewEl.firstChild);

      strip.querySelector('#tcd-switch').addEventListener('change', (e) => {
        TC_DEMO.start(e.target.value);
        const next = PERSONAS.find(x => x.id === e.target.value);
        if (next?.open && next.open !== (window.location.hash || '')) window.location.hash = next.open;
        else window.dispatchEvent(new Event('hashchange'));
      });
      strip.querySelector('#tcd-reset').addEventListener('click', () => {
        TC_DEMO.reset();
        window.dispatchEvent(new Event('hashchange'));
      });
      strip.querySelector('#tcd-exit').addEventListener('click', () => {
        TC_DEMO.stop();
        window.location.hash = '#/demo';
        window.dispatchEvent(new Event('hashchange'));
      });
      strip.querySelector('#tcd-log-toggle').addEventListener('click', () => {
        const box = document.getElementById('tcd-log');
        box.hidden = !box.hidden;
        renderLog();
      });
      renderLog();
    },

    /* ---- #/demo control panel ---- */
    renderPanel() {
      const isAdmin = ML.Auth?.currentProfile?.role === 'admin';
      if (!isAdmin) {
        return `<div class="section card"><h2>Demo Mode</h2>
          <p class="tc-muted">This preview tool is for lab admins. <a href="#/login">Sign in</a> with an admin account to use it.</p></div>`;
      }
      const groups = [...new Set(PERSONAS.map(p => p.group))];
      return `
        <div class="section card tcd-panel">
          <h2>Demo Mode — teacher &amp; student views</h2>
          <p class="tcd-intro">Pick a persona to render the real teacher/student screens against fake data.
            Buttons work: creating a code, joining with <code>K7M4PQ</code>, removing a student, and submitting a
            review all update the preview and are recorded in the action log. Nothing is written to Firestore, and
            no fake accounts are created.</p>
          <div class="tcd-warn">
            <strong>What this proves:</strong> layout, empty states, copy, and button wiring.<br>
            <strong>What it cannot prove:</strong> permissions — the browser is signed in as you (admin), so reads a
            real teacher would be denied still succeed here. For that, use a second Google account
            (see <code>CodeLog/ClaudesPlan/V3.632_teacher_rules_findings.md</code>).
          </div>
          ${groups.map(g => `
            <h3 class="tcd-group">${esc(g)}</h3>
            <div class="tcd-cards">
              ${PERSONAS.filter(p => p.group === g).map(p => `
                <div class="tcd-card${p.id === state.personaId ? ' tcd-card-on' : ''}">
                  <h4>${esc(p.label)}</h4>
                  <p>${esc(p.note)}</p>
                  <button type="button" class="btn btn-primary btn-small" data-tcd-start="${esc(p.id)}">
                    ${p.id === state.personaId ? 'Reload this view' : 'View as this user'}
                  </button>
                </div>`).join('')}
            </div>`).join('')}
          <h3 class="tcd-group">Public pages (with demo content)</h3>
          <p class="tc-muted">While a demo is running, these public sections read the fake reviews and teacher
            profiles — handy for checking the outward-facing copy:</p>
          <p><a class="btn btn-secondary btn-small" href="#/classes">Classes page (reviews strip)</a>
             <a class="btn btn-secondary btn-small" href="#/team">People page (featured teachers)</a>
             <a class="btn btn-secondary btn-small" href="#/classes/${esc(CLASS_1)}">Demo class page</a></p>
          ${state.persona ? `<p class="tcd-running">Running as <strong>${esc(state.persona.label)}</strong> —
            <button type="button" class="tcd-btn" id="tcd-panel-exit">exit demo</button></p>` : ''}
        </div>`;
    },

    wirePanel() {
      document.querySelectorAll('[data-tcd-start]').forEach(btn => {
        btn.addEventListener('click', () => {
          const id = btn.dataset.tcdStart;
          TC_DEMO.start(id);
          const p = PERSONAS.find(x => x.id === id);
          window.location.hash = p?.open || '#/dashboard';
        });
      });
      document.getElementById('tcd-panel-exit')?.addEventListener('click', () => {
        TC_DEMO.stop();
        window.dispatchEvent(new Event('hashchange'));
      });
    }
  };

  function renderLog() {
    const box = document.getElementById('tcd-log');
    if (!box || box.hidden) return;
    box.innerHTML = state.log.length
      ? state.log.map(e => `<div class="tcd-log-row tcd-log-${esc(e.kind)}">
          <span class="tcd-log-time">${e.at.toLocaleTimeString()}</span>
          <span>${esc(e.detail)}</span></div>`).join('')
      : '<div class="tcd-log-row">No actions yet — click something.</div>';
  }
  function updateBannerLog() {
    const c = document.getElementById('tcd-log-count');
    if (c) c.textContent = String(state.log.length);
    renderLog();
  }

  ML.TC_DEMO = TC_DEMO;
  ML.renderDemoPanel = () => TC_DEMO.renderPanel();
  ML.wireDemoPanel = () => TC_DEMO.wirePanel();

  // Restore across in-tab navigation (the fixture world itself resets on a
  // full page reload — deliberate, so a stale edit never confuses a demo).
  try {
    const saved = sessionStorage.getItem(SS_KEY);
    if (saved) TC_DEMO.start(saved);
  } catch (e) { /* private mode */ }
})();
