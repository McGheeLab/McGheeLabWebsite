/* ================================================================
   class-builder.js  —  Course Builder (V3.13)
   Tab-based page builder with nested widgets, autosave, and preview.
   Tabs contain sections; sections contain widgets.
   Uses McgheeLab.Scheduler for the speakers scheduling component.
   ================================================================ */

window.McgheeLab = window.McgheeLab || {};

(() => {

/* ─── Registries ─────────────────────────────────────────────── */
const SECTION_REG = {
  // V3.656 — these four moved from component:'text' to 'richtext' so a syllabus
  // or a 16-week schedule can carry headings, lists and tables instead of being
  // one <br>-joined run of plain lines. Editing is still a plain textarea; only
  // the read-only render changed. BME 295C uses its own syllabus295c /
  // schedule295c components and is untouched.
  overview:    { label: 'Overview',       component: 'richtext', field: 'overviewContent' },
  syllabus:    { label: 'Syllabus',       component: 'richtext', field: 'syllabusContent' },
  schedule:    { label: 'Class Schedule', component: 'richtext', field: 'scheduleContent' },
  speakers:    { label: 'Guest Speakers', component: 'speakers' },
  files:       { label: 'Files',          component: 'files',   path: 'files' },
  simulations: { label: 'Simulations',    component: 'richtext', field: 'simulationsContent' },
  lectures:    { label: 'Lecture Notes',  component: 'files',   path: 'lectures' },
  homeworks:   { label: 'Assignments',    component: 'files',   path: 'homeworks', hasDue: true },
  exams:       { label: 'Exams',          component: 'files',   path: 'exams',     hasDue: true },
  modules:     { label: 'Learning Modules', component: 'modules' },
  /* V3.803 — lists derived from the module TYPE. An entry whose `type` is
     homework / homework_key / report / test is still managed in its Learning
     Modules section (the "stack") but is LISTED here on the public page.
     ensureTypedModuleTabs() creates these sections the first time a module of
     the type exists, so they are never added by hand. */
  homeworkModules:   { label: 'Homework & Keys', component: 'typedModules', types: ['homework', 'homework_key'], tabName: 'Homeworks' },
  reportTestModules: { label: 'Reports & Tests', component: 'typedModules', types: ['report', 'test'],          tabName: 'Reports & Tests' },
  // BME 295C class-specific sections (V3.244). Hard-coded against
  // modules/bme295c/content.json; not generalized to other courses.
  checkin295c:  { label: 'Student Check-in (BME 295C)',     component: 'checkin295c' },
  syllabus295c: { label: 'Syllabus (BME 295C)',             component: 'syllabus295c' },
  schedule295c: { label: 'Speaker Schedule (BME 295C)',     component: 'schedule295c' },
  modules295c:  { label: 'Discussion Modules (BME 295C)',   component: 'modules295c' },
  roster295c:   { label: 'Student Roster (BME 295C, admin)', component: 'roster295c' },
  chat295c:     { label: 'Course Chat (BME 295C)',           component: 'chat295c' },
  // V3.286 — end-of-course feedback. Per-student doc at
  // schedules/bme295c/assessments/{uid}; gated by _classData.assessmentState
  // (closed → open → locked). Admin sees aggregated panels on the dashboard.
  assessment295c:{ label: 'Course Assessment (BME 295C)',    component: 'assessment295c' },
  adminDash295c:{ label: 'Admin Dashboard (BME 295C)',       component: 'adminDash295c' },
  // V3.674 — BME466 homework-progress usage dashboard (reads hwProgress/*,
  // written by the NetID cloud-save block inside the homework modules).
  hwDash466:    { label: 'HW Progress Dashboard (BME466)',   component: 'hwDash466' },
  /* V3.681 — BME466 course platform. Three surfaces, three audiences:
     hwList466  public   — the Homeworks page (published assignments only)
     hwMine466  student  — my assignments, my profile/section, my requests
     hwAssign466 staff   — assign homework, status matrix, requests inbox
     NOTE: the key `homeworks` above is an unrelated classFiles uploader that
     happens to be labelled "Assignments"; these are deliberately distinct. */
  hwList466:    { label: 'Homeworks (BME466)',               component: 'hwList466' },
  hwMine466:    { label: 'My Homework (BME466, students)',   component: 'hwMine466' },
  hwAssign466:  { label: 'Assignments & Requests (BME466, staff)', component: 'hwAssign466' },
  // V3.677 — live lecture whiteboard (generic, any class). Body + all
  // behavior live in whiteboard.js; this module only delegates.
  whiteboard:   { label: 'Whiteboard (live drawing)',        component: 'whiteboard' }
};

const WIDGET_REG = {
  text:       { label: 'Text Block' },
  image:      { label: 'Image' },
  video:      { label: 'Video' },
  links:      { label: 'Link List' },
  embed:      { label: 'Embed' },
  simulation: { label: 'Simulation' },
  divider:    { label: 'Divider' }
};

/* ─── Module State ───────────────────────────────────────────── */
let _scheduleId = null;
let _classData = null;
let _speakers = [];
let _currentSpeaker = null;
let _viewType = 'public';
let _useKeyAuth = false;
let _adminViewMode = 'admin';
let _previewSpeakerIdx = 0;
let _tabs = [];
let _activeTabId = null;
let _previewMode = false;
let _fileData = {};
let _dirty = false;
let _autosaveTimer = null;
let _hashChangeHandler = null;
let _beforeUnloadHandler = null;
let _moduleManifest = null;  // Cached manifest.json for file picker
// BME 295C (V3.244) — static content + per-user profile cache for the
// class-specific sections. Populated by wireClassPage when any 295c
// section is present in _tabs.
let _bmeContent = null;          // modules/bme295c/content.json (memoized)
let _bmeProfile = null;          // current signed-in user's users/{uid}.bme295c subobject
let _bmeGroupProfiles = null;    // Map<email, users/{uid}.bme295c> for groupmates
let _bmeRosterEntry = null;      // current user's matched roster entry (or null)
let _bmeProfileSaveTimer = null; // debounce timer for profile autosave
let _bmeGroupResponses = null;   // Map<speakerSlug, response doc> for current user's group
let _bmeResponseSaveTimers = {}; // per-speaker debounce timers for response autosave
let _bmeSubmitInFlight = new Set(); // V3.285 — slugs whose submit click is in-flight; second click during in-flight is a no-op (kills the V3.285 audit's rank-12 double-click clobber)
let _bmeAssessment = null;       // V3.286 — current student's end-of-course assessment doc cache (one per uid)
let _bmeAssessmentSaveTimer = null; // V3.286 — 800ms debounce for assessment autosave
let _bmeAssessmentSubmitInFlight = false; // V3.286 — submit click dedup (matches V3.285 _bmeSubmitInFlight pattern but boolean since there's only one assessment doc)
let _bmeBannerFocusDay = null;   // V3.246 — banner's currently-focused day (rotation-chip click overrides "today")
let _isClassAdminOnly = false;   // V3.247 — true if user is a BME 295C class admin but NOT a global admin (different welcome strip)
/* V3.681 — narrow course staff (a TA on schedules/{id}.courseStaffEmails).
   Deliberately NOT folded into `isAdmin`: admin means edit chrome, the roster
   and progress deletion, and V3.679's whole point is that an @arizona.edu
   account must not get those. This flag opens the staffOnly tabs only. */
let _isCourseStaff = false;
let _realIsCourseStaff = false;

// V3.248 — admin "View as" override. Real admins can preview the page
// as if signed-out (public) or as a specific roster student. Stored in
// module scope so it survives tab/section swaps within one navigation.
// `null` = no override; render with the user's real role.
// `{ type: 'public' }` = treat as signed-out.
// `{ type: 'student', studentId: '...' }` = impersonate that roster entry.
let _adminViewOverride = null;
let _realIsAdmin = false;        // captured during wireClassPage — the unfiltered "real" admin flag, so the toolbar can show even after override hides admin UI
let _realIsClassAdminOnly = false;
let _bmeDashboardData = null;    // lazy-loaded: { profilesByEmail: Map, responses: Map<docId, doc> }
let _bmeDashboardLoading = false;
let _bmeDashboardUnsub = null;   // V3.251 — Firestore onSnapshot handle for groupResponses (live monitor)
let _bmeScheduleUnsub = null;    // V3.285 — Firestore onSnapshot handle for the schedule doc itself; propagates admin gate flips / roster edits / attendance saves to live student sessions without a reload
let _bmeAssessmentsUnsub = null; // V3.286 — Firestore onSnapshot handle for schedules/bme295c/assessments (admin aggregated view)
let _bmeMonitorTickInterval = null; // V3.251 — interval id for refreshing "X ago" timestamps

// V3.251 — Live Q&A chat state. `_bmeChatUnsub` is the Firestore
// onSnapshot teardown function; cleanupListeners() invokes it on
// navigation away. `_bmeChatScrollPinned` defaults true so the first
// render auto-scrolls to bottom; the scroll listener flips it false
// when the user scrolls up to read history. `_bmeMentionState` tracks
// an in-progress @-mention autocomplete (start index + prefix typed
// so far) so we can render the dropdown and replace the right slice
// of text on selection.
let _bmeChatMessages = [];
let _bmeChatUnsub = null;
let _bmeChatScrollPinned = true;
let _bmeMentionState = null;     // null | { startIdx: number, prefix: string, activeIdx: number }
let _bmeOtherProfileCache = new Map();  // rosterId → users/{uid}.bme295c snapshot, fetched on profile-view modal open
let _bmeChatProfilesLoaded = false;     // V3.256 — true once loadBmeChatProfiles has bulk-populated the cache for the chat tab

/* ─── Default Schedule Seed ──────────────────────────────────── */
// Roster pre-seeded from modules/bme295c/students.md (V3.245).
// email + campus + highSchool derived from the UAccess admissions extract
// (`RPT_AD_ALL_NDS_APPS_BMEHSND-30355797.xlsx`); campus assigned by home
// city — Tucson/Vail → Tucson, Phoenix/Chandler/Gilbert/Tempe → Phoenix.
// Admin can still override email/campus/highSchool/groupNumber in the
// admin-only roster section.
const BME295C_ROSTER_SEED = [
  { id: '24122572', name: 'Ajao, Gabriel A',           pronouns: '',             email: 'ajao@arizona.edu',          campus: 'Tucson',  highSchool: 'Mica Mountain HS',           groupNumber: null },
  { id: '24122531', name: 'Bhimani, Ryan',             pronouns: '',             email: 'bhimani.ryan@gmail.com',    campus: 'Phoenix', highSchool: 'Arizona College Prep - Erie', groupNumber: null },
  { id: '23982811', name: 'Bialis, Ethan Alexander',   pronouns: 'he/him/his',   email: 'ethanbialis@arizona.edu',   campus: 'Tucson',  highSchool: 'The Gregory School',         groupNumber: null },
  { id: '24121966', name: 'Bowles, Kai W',             pronouns: '',             email: 'kaiwbowles9@icloud.com',    campus: 'Tucson',  highSchool: 'Cienega HS',                 groupNumber: null },
  { id: '24122183', name: 'Cheon, Kaylee Jihoo',       pronouns: '',             email: 'kachlee210@gmail.com',      campus: 'Phoenix', highSchool: 'Arizona College Prep - Erie', groupNumber: null },
  { id: '24122565', name: 'Daftardar, Siya Siddhartha',pronouns: '',             email: 'daftardar@arizona.edu',     campus: 'Phoenix', highSchool: 'Arizona College Prep - Erie', groupNumber: null },
  { id: '24121208', name: 'Efrat, Roey Zavisca',       pronouns: 'he/him/his',   email: 'roeyefrat@arizona.edu',     campus: 'Tucson',  highSchool: 'University HS',              groupNumber: null },
  { id: '24121952', name: 'Galvan, Jaz Khalyl',        pronouns: '',             email: 'jazgalvan@arizona.edu',     campus: 'Tucson',  highSchool: 'University HS',              groupNumber: null },
  { id: '24121034', name: 'Graham, Deegan Ryder',      pronouns: '',             email: 'deegangraham@arizona.edu',  campus: 'Tucson',  highSchool: 'Empire HS',                  groupNumber: null },
  { id: '24121310', name: 'Hackett, Noah Gray',        pronouns: '',             email: 'noahhackett@arizona.edu',   campus: 'Tucson',  highSchool: 'University HS',              groupNumber: null },
  { id: '24121510', name: 'Hsieh, Sing-Yeh',           pronouns: '',             email: 'syhsieh@arizona.edu',       campus: 'Tucson',  highSchool: 'University HS',              groupNumber: null },
  { id: '24121927', name: 'Jimenez, EJ Jose Alberto',  pronouns: '',             email: 'jimenezej@arizona.edu',     campus: 'Phoenix', highSchool: 'Bioscience HS',              groupNumber: null },
  { id: '24122754', name: 'Kopp, Abigail',             pronouns: '',             email: 'agkopp0401@gmail.com',      campus: 'Tucson',  highSchool: 'Cienega HS',                 groupNumber: null },
  { id: '24122181', name: 'Krishnadoss, Aparna',       pronouns: '',             email: 'aparnakr@arizona.edu',      campus: 'Phoenix', highSchool: 'Arizona College Prep - Erie', groupNumber: null },
  { id: '24121995', name: 'Mitchell, Lilly Elyse',     pronouns: 'she/her/hers', email: 'mitchelll@arizona.edu',     campus: 'Tucson',  highSchool: 'Cienega HS',                 groupNumber: null },
  { id: '24121018', name: 'Mulimani, Esha',            pronouns: '',             email: 'esha.mulimani@gmail.com',   campus: 'Phoenix', highSchool: 'BASIS Ahwatukee',            groupNumber: null },
  { id: '24113407', name: 'Nath, Marsha',              pronouns: '',             email: 'marshanath@arizona.edu',    campus: 'Tucson',  highSchool: 'University HS',              groupNumber: null },
  { id: '24121961', name: 'Padmakumar, Pranitha',      pronouns: '',             email: 'pranitha1028@arizona.edu',  campus: 'Phoenix', highSchool: 'Arizona College Prep - Erie', groupNumber: null },
  { id: '24122306', name: 'Reblin, Landon James',      pronouns: '',             email: 'lreblin@arizona.edu',       campus: 'Tucson',  highSchool: 'Mica Mountain HS',           groupNumber: null },
  { id: '24122574', name: 'Ung, Yvie',                 pronouns: '',             email: 'ungy@arizona.edu',          campus: 'Tucson',  highSchool: 'Mica Mountain HS',           groupNumber: null },
  { id: '24121946', name: 'Van Cleave Perlin, Claudia',pronouns: '',             email: 'claudiaperlin@arizona.edu', campus: 'Phoenix', highSchool: 'Bioscience HS',              groupNumber: null },
  { id: '23947064', name: 'Wilson-Badillo, Makenzie',  pronouns: 'she/her/hers', email: 'mwilsonbadillo@arizona.edu',campus: 'Tucson',  highSchool: 'University HS',              groupNumber: null }
];

const DEFAULT_SCHEDULES = {
  'bme295c': {
    id: 'bme295c',
    title: 'BME 295C — Challenges in Biomedical Engineering',
    subtitle: 'A one-week summer course for rising high-school juniors and seniors',
    semester: 'Summer 2026',
    description: 'Interactive lectures, lab tours, and small-group discussions with UA faculty across the Tucson and Phoenix campuses.',
    startDate: '2026-06-08',
    endDate: '2026-06-12',
    ownerUid: null,
    classAdminEmails: [],
    testMode: false,
    studentRoster: BME295C_ROSTER_SEED,
    tabs: [
      {
        id: 'tab_295c_syllabus',
        name: 'Syllabus',
        sections: [
          { key: 'checkin295c',  id: 'sec_295c_checkin',  name: 'Student Check-in',  collapsed: false, widgets: [] },
          { key: 'syllabus295c', id: 'sec_295c_syllabus', name: 'Course Information', collapsed: false, widgets: [] }
        ]
      },
      {
        id: 'tab_295c_schedule',
        name: 'Schedule',
        sections: [
          { key: 'schedule295c', id: 'sec_295c_schedule', name: 'Speakers & Lab Tours', collapsed: false, widgets: [] }
        ]
      },
      {
        id: 'tab_295c_modules',
        name: 'Learning Modules',
        sections: [
          { key: 'modules295c', id: 'sec_295c_modules', name: 'Discussion Points', collapsed: false, widgets: [] }
        ]
      },
      {
        id: 'tab_295c_chat',
        name: 'Course Chat',
        sections: [
          { key: 'chat295c', id: 'sec_295c_chat', name: 'Course Chat', collapsed: false, widgets: [] }
        ]
      },
      {
        id: 'tab_295c_assessment',
        name: 'Course Assessment',
        sections: [
          { key: 'assessment295c', id: 'sec_295c_assessment', name: 'Course Assessment', collapsed: false, widgets: [] }
        ]
      },
      {
        id: 'tab_295c_admin',
        name: 'Admin Dashboard',
        adminOnly: true,
        sections: [
          { key: 'adminDash295c', id: 'sec_295c_admin_dash', name: 'Dashboard', collapsed: false, widgets: [] }
        ]
      }
    ]
  },
  /* V3.656 — BME/AME 466/566 Biomechanics (F26). Uses the GENERIC section types
     (syllabus / schedule / modules), not a bespoke surface like BME 295C's.
     Seeded here rather than hand-written into Firestore so the page is live the
     moment this ships; resolveSchedule() prefers Firestore, so the first in-UI
     save takes over and this becomes the offline fallback. Deliberately carries
     NO studentRoster / attendance / grades — schedules/{id} is world-readable
     (firestore.rules: `allow read: if true`), so nothing student-identifying
     goes in this document. */
  'bme466': {
    id: 'bme466',
    title: 'BME/AME 466/566 — Biomechanics',
    subtitle: 'Mechanical forces in living systems, from molecules to gait',
    semester: 'Fall 2026',
    level: 'Undergraduate / Graduate',
    description: 'How mechanical forces interact with living systems across scales — molecular diffusion and binding, cellular traction and migration, blood flow and tissue transport, and muscle and gait.',
    startDate: '2026-08-24',
    endDate: '2026-12-09',
    ownerUid: null,
    /* V3.679 — deliberately EMPTY. The instructor view (edit chrome, the
       admin-only Dashboard tab, hwProgress list/delete) is reached only
       through the global admin role on mcgheealex@gmail.com. The UA NetID
       mcgheealex@arizona.edu used to sit here, which meant signing in with
       the same kind of account a student uses (@arizona.edu is what the
       homework modules require) handed out the instructor view. Anyone
       added here gets class-admin rights in the client AND in
       firestore.rules' bme466ClassAdmin(). */
    classAdminEmails: [],
    /* V3.681 — the NARROW TA list. Grants only the course surfaces added in
       V3.681 (assignment manager, status matrix, requests inbox, section
       assignment). NOT page-edit chrome, NOT the roster/CSV import, NOT
       progress deletion — so naming a TA here no longer means handing them
       the instructor view, which is what kept V3.679 from having a usable
       answer for "assign a user to be a TA". Mirrored by
       firestore.rules' bme466CourseStaff(). */
    courseStaffEmails: [],
    testMode: false,
    tabs: [
      {
        id: 'tab_466_syllabus',
        name: 'Syllabus',
        sections: [
          { key: 'syllabus', id: 'sec_466_syllabus', name: 'Course Information', collapsed: false, widgets: [],
            content: `## Course description

BME/AME 466/566 is an interdisciplinary course exploring how mechanical forces interact with
living systems across biological scales — beginning with individual molecules and cells and
building to tissues, organs, and the whole body. Bridging physics, engineering, biology, and
physiology, it equips you with the tools to analyse how mechanical cues influence biological
function, development, disease progression, and injury. (3 units)

## Logistics

| **Term** | Fall 2026 — Aug 24 to Dec 9, 2026 |
| **Meetings** | Tuesday & Thursday, 9:30–10:45 AM, in person |
| **Instructor** | Alexander McGhee, Ph.D. — mcgheealex@arizona.edu |
| **Office hours** | TBA |
| **Teaching assistant** | TBA |
| **Course platform** | D2L for submissions and grades; modules and schedule here |

## Prerequisites

A basic course in statics (CE 214) and a basic course in differential equations (MATH 254),
or consent of the instructor. Undergraduates in the College of Engineering need advanced
standing. Students from outside the College of Engineering should contact the instructor to
discuss interests and obtain consent to enrol.

## Textbook

**No textbook is required.** Lecture notes and interactive modules are provided. These
references are available electronically through the University of Arizona Libraries:

- Milo et al., *Cell Biology by the Numbers* (2016)
- Hibbeler, *Engineering Mechanics — Statics*, 14th ed.
- Selected readings from the peer-reviewed literature in cellular biomechanics,
  mechanotransduction, and fluid mechanics

## Course topics

The course builds understanding from the molecular to the whole-body scale.

### Part I — Molecular scale
Diffusion and reaction dynamics; how molecular transport and binding kinetics regulate
cellular behaviour. Mechanics of cell membranes: lipid-bilayer mechanics, deformation, and
mechanical stress and damage at the nanoscale.

### Part II — Cellular scale
Traction force generation — how cells generate and transmit force through the cytoskeleton to
their environment during migration and adhesion. The mechanobiology of cell migration, and the
viscoelastic mechanics of the extracellular matrix.

### Part III — Tissue scale
Hemodynamics and blood rheology: the non-Newtonian behaviour of blood, flow through vessels,
capillary exchange, and oxygen delivery. Spatial gradients and mass transport in the tumour
microenvironment.

### Part IV — System scale
Musculoskeletal tissue mechanics; muscle mechanics and force production; and human motion and
gait analysis.

## Grading

| Component | Weight |
|---|---|
| Homework (7 assignments) | 25% |
| Midterm exam | 25% |
| Final exam | 25% |
| Reports | 10% |
| Final project | 15% |

Letter grades follow the standard UArizona scale: A ≥ 90, B ≥ 80, C ≥ 70, D ≥ 60, E < 60.
Cut-offs may be lowered but will not be raised.

## Expected learning outcomes

By the end of this course you will have a working understanding of:

- the statistical mechanics that govern cellular processes
- the cellular response to mechanical stress, including injury
- forces within the circulatory system and their relationship to blood pressure, blood flow,
  and edema
- the fundamental mechanical principles governing muscle force generation
- the relationship between tissue structure and function in biological materials

### ABET outcomes

- **Outcome 1 — Problem solving.** You will solve open-ended, biologically inspired problems
  using order-of-magnitude analysis, thermodynamic reasoning, and uncertainty quantification.
- **Outcome 3 — Communication.** You will deliver an oral presentation in the format of a
  scientific conference talk.
- **Outcome 6 — Experimentation and analysis.** You will analyse quantitative data from
  cellular imaging experiments to calculate traction forces on deformable substrates.
- **Outcome 7 — Lifelong learning.** You will identify and use publicly available
  computational tools through guided tutorials and self-directed exploration.

## Graduate students (466 vs 566)

This course is delivered concurrently to undergraduate and graduate students with
differentiated expectations. Graduate students will additionally:

- apply advanced mathematical modelling, including deriving and solving governing equations
- critically evaluate current literature and synthesise findings into a research context
- formulate and justify assumptions in multiscale models, linking molecular or cellular
  behaviour to tissue- and system-level phenomena

Concretely: **1–2 additional open-ended challenge problems per homework**, a fully
self-directed final project rather than a guided one, and exam grading against a
graduate-level rubric emphasising synthesis and defence of complex solutions.

## Policies

### Examinations
All exams are **take-home**, with a completion window of at least five days. They consist of
open-ended questions requiring independent analysis and original problem-solving. You must
work individually.

### Collaboration and disclosure
Collaborative learning is encouraged, particularly on open-ended problems — but transparency
is required. You must clearly disclose all collaborators and acknowledge every external
resource used, including human and digital tutors, printed and online material, software and
computational tools, forums, and **AI tools or assistants**. Failure to disclose may be
treated as a violation of academic integrity.

### Use of AI
You may use AI tools to clarify concepts, brainstorm approaches, and debug code you wrote.
You may **not** submit AI-generated prose, calculations, or figures as your answers, and you
may **not** fabricate data, measurements, timestamps, figure references, or sources. Each
problem asks for a one-or-two-sentence note on what you used AI for.

### Teamwork
Group work is assessed with a peer evaluation at the end of each group project covering
professionalism, communication, and effort. Individual grades within a team may differ based
on reported contributions.

### Attendance
If you feel unwell, stay home and notify the instructor. Non-attendance does not
automatically extend a deadline — coordinate with the instructor directly. If you must miss
more than a week of class, contact the Dean of Students Office.

### University policies
The full list of University of Arizona syllabus policies — including academic integrity,
accessibility and accommodation, nondiscrimination, and threatening behaviour — is at
https://catalog.arizona.edu/syllabus-policies

## Support

- **Academic advising** — https://advising.arizona.edu/advisors/major
- **Dean of Students Office** — (520) 621-2057, DOS-deanofstudents@email.arizona.edu
- **Campus Health** — (520) 621-9202; after hours (520) 570-7898
- **Counseling & Psych Services (CAPS), 24/7** — (520) 621-3334` }
        ]
      },
      {
        id: 'tab_466_schedule',
        name: 'Schedule',
        sections: [
          { key: 'schedule', id: 'sec_466_schedule', name: 'Weekly Schedule', collapsed: false, widgets: [],
            content: `Sixteen weeks, Tuesday and Thursday. **The only class cancelled all semester is
Thursday Nov 26** (Thanksgiving recess) — Labor Day and Veterans Day both fall outside our
meeting days. Two weeks meet once: Nov 24 and Dec 8.

Topics and dates are firm; assessment dates may shift and are announced on D2L.

## Part I — Molecular scale

| Wk | Dates | Topic | Assessment |
|---|---|---|---|
| 1 | Aug 25 / 27 | Diffusion — why anything moves at all | |
| 2 | Sep 1 / 3 | Fick's laws and diffusion-limited reactions | HW1 out |
| 3 | Sep 8 / 10 | Binding — how a cell reads a concentration | |
| 4 | Sep 15 / 17 | The limit of sensing, and the membrane that senses | HW2 out · Report 1 out |

## Part II — Cellular scale

| Wk | Dates | Topic | Assessment |
|---|---|---|---|
| 5 | Sep 22 / 24 | Actin — a filament that pushes | |
| 6 | Sep 29 / Oct 1 | The Brownian ratchet and network architecture | HW3 out |
| 7 | Oct 6 / 8 | The motor–clutch | HW4 out |
| 8 | Oct 13 / 15 | The matrix pushes back — viscoelasticity | Report 1 due |

## Part III — Tissue scale

| Wk | Dates | Topic | Assessment |
|---|---|---|---|
| 9 | Oct 20 / 22 | Blood is not a fluid — it's a suspension | **Midterm out** |
| 10 | Oct 27 / 29 | Blood rheology and flow in a compliant tube | HW5 out · Midterm due |
| 11 | Nov 3 / 5 | Exchange at the capillary, and oxygen to the tissue | |
| 12 | Nov 10 / 12 | Spatial gradients and mass transport in the tumour microenvironment | HW6 out · Final project out |
| 13 | Nov 17 / 19 | Lung mechanics and ventilation–perfusion | |

## Part IV — System scale

| Wk | Dates | Topic | Assessment |
|---|---|---|---|
| 14 | Nov 24 *(Tue only)* | Musculoskeletal tissue mechanics | HW7 out |
| 15 | Dec 1 / 3 | Muscle and movement | |
| 16 | Dec 8 *(Tue only)* | Synthesis and final project presentations | **Final exam out** |

---

**Final exam** is take-home, due during the final examination period (Dec 11–17).
**Last day of classes** is Wednesday Dec 9; **Dec 10** is Reading Day.` }
        ]
      },
      {
        id: 'tab_466_modules',
        name: 'Learning Modules',
        sections: [
          { key: 'modules', id: 'sec_466_modules', name: 'Learning Modules', collapsed: false, widgets: [] }
        ]
      },
      /* V3.677 — live lecture whiteboard (whiteboard.js). NOTE: if
         schedules/bme466 has already been saved to Firestore, this seed
         edit is invisible (resolveSchedule prefers Firestore) — add the
         tab once through the class editor UI instead. */
      {
        id: 'tab_466_whiteboard',
        name: 'Whiteboard',
        sections: [
          { key: 'whiteboard', id: 'sec_466_whiteboard', name: 'Lecture Whiteboards', collapsed: false, widgets: [] }
        ]
      },
      /* V3.681 — the public Homeworks page. Lists PUBLISHED assignment
         records from schedules/bme466/assignments (world-readable when
         published), so a student can see what is due without signing in. */
      {
        id: 'tab_466_homeworks',
        name: 'Homeworks',
        sections: [
          { key: 'hwList466', id: 'sec_466_hwlist', name: 'Assignments & Due Dates', collapsed: false, widgets: [] }
        ]
      },
      /* V3.681 — the student dashboard. studentOnly: any signed-in
         @arizona.edu account, hidden from anonymous visitors (there is
         nothing in it for them and it would only prompt a sign-in wall). */
      {
        id: 'tab_466_mine',
        name: 'My Homework',
        studentOnly: true,
        sections: [
          { key: 'hwMine466', id: 'sec_466_mine', name: 'My Assignments', collapsed: false, widgets: [] }
        ]
      },
      /* V3.681 — staff surface. staffOnly (NOT adminOnly): a
         courseStaffEmails TA must reach this without being elevated to
         admin, because admin also means page-edit chrome + the roster. */
      {
        id: 'tab_466_assign',
        name: 'Assignments & Requests',
        staffOnly: true,
        sections: [
          { key: 'hwAssign466', id: 'sec_466_assign', name: 'Assign & Respond', collapsed: false, widgets: [] }
        ]
      },
      /* V3.674 — usage dashboard over the hwProgress cloud saves (pretest
         pilot). Admin-only: visible to global admins and, via the
         classAdminEmails elevation in wireClassPage, to the instructor. */
      {
        id: 'tab_466_dashboard',
        name: 'Dashboard',
        adminOnly: true,
        sections: [
          { key: 'hwDash466', id: 'sec_466_hwdash', name: 'Homework Progress', collapsed: false, widgets: [] }
        ]
      },
    ],
    // Release control: flip `published` to true (the "Visible" checkbox in the
    // Learning Modules section, admin view) to open a module to students.
    modules: [
      /* V3.674 — pretest (HW0): ungraded baseline diagnostic + the cloud-save
         pilot. Published from day one; completion credit is the D2L upload. */
      { id: 'mod_466_hw00_pretest', title: 'Pretest — Where You\'re Starting From (HW-00)',
        folder: 'bme466', htmlFile: 'hw-00-pretest.html', order: -1, published: true },
      { id: 'mod_466_w01_diffusion', title: 'Week 1 — Diffusion: Why Anything Moves at All',
        folder: 'bme466', htmlFile: '01-diffusion-why-anything-moves.html', order: 0, published: true },
      /* V3.659 — instructor board notes, kept unpublished. Admins see it in this
         list with the "Visible" box unticked; the public renderer filters on
         `published`, so students never see the row. The file itself is still an
         unauthenticated static asset — this hides the row, not the file, so keep
         exam keys and grades out of it. Deliberately NOT "_"-prefixed: the
         leading underscore keeps a file out of manifest.json (see
         scan_modules.py), which would also keep it out of the "+ Add Module"
         picker, and this one needs to be pickable there. */
      { id: 'notes_466_w01', title: 'Week 1 — board notes',
        folder: 'bme466', htmlFile: 'w01-instructor-notes.html', order: 1,
        kind: 'notes', published: false },
      /* V2.48: HW1 v2 ("Transport Problems") replaces the never-published v1;
         v1's files stay deployed as the archived fallback but leave the catalog. */
      { id: 'mod_466_hw01_brief', title: 'Homework 1 — Assignment (read first)',
        folder: 'bme466', htmlFile: 'hw1-transport-problems.html', order: 2, published: true },
      { id: 'mod_466_hw01_bench', title: 'Homework 1 — Transport Problems: Your Own Bench',
        folder: 'bme466', htmlFile: 'hw-01-transport-problems.html', order: 3, published: true },
      /* V2.79: HW2 "Reading and Building" (Weeks 3–4) — one data tab (the Microscope),
         five problems, the walk-to-the-wound challenge. Released 2026-09-16. */
      { id: 'mod_466_hw02_brief', title: 'Homework 2 — Assignment (read first)',
        folder: 'bme466', htmlFile: 'hw2-reading-and-building.html', order: 4, published: true },
      { id: 'mod_466_hw02_bench', title: 'Homework 2 — Reading and Building: The Microscope',
        folder: 'bme466', htmlFile: 'hw-02-reading-and-building.html', order: 5, published: true },
      /* V2.82: Report 1 "Read & Rebuild" — one of three short papers, re-derived and
         re-measured on two seeded benches. The written prompt is a PDF on D2L; this is
         the bench + answer module the results file is exported from. Out Week 4. */
      { id: 'mod_466_report01', title: 'Report 1 — Read & Rebuild (journal review)',
        folder: 'bme466', htmlFile: 'report-01-journal-review.html', order: 6, published: true },
      /* V3.798: HW3 "Grip and Ground" (Weeks 5–6) — no data tab; three problems, each
         joining two relations, plus the 566 challenge by hand. The row starts HIDDEN
         (Visible unticked): the V3.798 migration copies it onto the live schedule,
         and an admin visit before the FTP must not show students a link that 404s.
         V3.800: the module only — Alex wants no separate "read first" page for HW3. */
      { id: 'mod_466_hw03_bench', title: 'Homework 3 — Grip and Ground: Your Dataset',
        folder: 'bme466', htmlFile: 'hw-03-grip-and-ground.html', order: 7, published: false }
    ]
  }
};

/* ================================================================
   HELPERS
   ================================================================ */
function esc(s) { const el = document.createElement('div'); el.textContent = s ?? ''; return el.innerHTML; }
/** Escape for safe use inside HTML attribute values (escapes quotes too) */
function escAttr(s) { return (s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function generateKey() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

function getInviteKeyFromURL() {
  const hash = window.location.hash || '';
  const q = hash.indexOf('?');
  if (q === -1) return null;
  return new URLSearchParams(hash.slice(q + 1)).get('key') || null;
}

function buildInviteURL(scheduleId, key) {
  return `${location.origin}${location.pathname}#/classes/${scheduleId}?key=${key}`;
}

function fmtSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function renderText(raw) {
  if (!raw) return '<p class="muted-text">No content yet.</p>';
  return raw.split('\n').map(line => {
    const linked = esc(line).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
    return linked || '<br>';
  }).join('<br>');
}

/* V3.656 — richer renderer for the generic text sections (overview / syllabus /
   schedule / simulations). renderText() above is deliberately left alone so any
   caller still on it behaves exactly as before.

   Supported, and nothing else: "## heading", "### heading", "**bold**",
   "- bullet", "1. numbered", "| table | rows |" with a |---|---| separator,
   "---" horizontal rule, blank-line paragraphs, and bare-URL auto-linking.
   Everything is esc()'d BEFORE any marker is applied, so this is no more
   permissive than renderText(). */
function renderRichText(raw) {
  if (!raw || !String(raw).trim()) return '<p class="muted-text">No content yet.</p>';

  const inline = (t) => esc(t)
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');

  const isTableRow = (l) => /^\s*\|.*\|\s*$/.test(l);
  const isTableSep = (l) => /^\s*\|[\s:|-]+\|\s*$/.test(l);
  const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
  // Does this line open a non-paragraph block? Used only to decide where a
  // paragraph ends, never to decide whether to advance.
  const isBlockStart = (l) => /^\s*(#{2,4})\s+/.test(l)
    || /^\s*[-*]\s+/.test(l)
    || /^\s*\d+[.)]\s+/.test(l)
    || /^\s*---+\s*$/.test(l)
    || isTableRow(l);

  const lines = String(raw).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { i++; continue; }

    // Table: a row, optionally followed by a separator, then more rows.
    if (isTableRow(line) && !isTableSep(line)) {
      const head = cells(line);
      let j = i + 1;
      const hasSep = j < lines.length && isTableSep(lines[j]);
      if (hasSep) j++;
      const body = [];
      while (j < lines.length && isTableRow(lines[j]) && !isTableSep(lines[j])) {
        body.push(cells(lines[j])); j++;
      }
      let t = '<div class="cb-rt-tablewrap"><table class="cb-rt-table">';
      if (hasSep) {
        t += '<thead><tr>' + head.map(c => `<th>${inline(c)}</th>`).join('') + '</tr></thead>';
      } else {
        body.unshift(head);
      }
      t += '<tbody>' + body.map(r => '<tr>' + r.map(c => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') + '</tbody>';
      out.push(t + '</table></div>');
      i = j; continue;
    }

    // Horizontal rule
    if (/^\s*---+\s*$/.test(line)) { out.push('<hr class="cb-rt-hr">'); i++; continue; }

    // Headings
    let m = line.match(/^\s*(#{2,4})\s+(.*)$/);
    if (m) {
      const lvl = Math.min(m[1].length + 1, 5); // ## -> h3, ### -> h4
      out.push(`<h${lvl} class="cb-rt-h">${inline(m[2])}</h${lvl}>`);
      i++; continue;
    }

    // Unordered list
    if (/^\s*[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(inline(lines[i].replace(/^\s*[-*]\s+/, ''))); i++;
      }
      out.push('<ul class="cb-rt-list">' + items.map(x => `<li>${x}</li>`).join('') + '</ul>');
      continue;
    }

    // Ordered list
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(inline(lines[i].replace(/^\s*\d+[.)]\s+/, ''))); i++;
      }
      out.push('<ol class="cb-rt-list">' + items.map(x => `<li>${x}</li>`).join('') + '</ol>');
      continue;
    }

    // Paragraph: consecutive plain lines.
    //
    // This branch ALWAYS consumes lines[i] before looking further, so `i` can
    // never stall. That matters: a line can reach here having matched none of
    // the branches above -- a table-separator row with no table above it, e.g.
    // an all-empty header row `| | |`, satisfies isTableSep() and so is skipped
    // by the table branch -- and a condition-guarded loop would spin forever,
    // hanging the class page. Consume-first makes progress structural.
    const buf = [lines[i]];
    i++;
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) {
      buf.push(lines[i]); i++;
    }
    out.push(`<p>${buf.map(inline).join('<br>')}</p>`);
  }

  return out.join('\n') || '<p class="muted-text">No content yet.</p>';
}

function genBlockId() {
  return 'blk_' + Math.random().toString(16).slice(2, 8);
}

function genTabId() {
  return 'tab_' + Math.random().toString(16).slice(2, 8);
}

/* ─── Editing check ─────────────────────────────────────────── */
function isEditing() { return _viewType === 'admin' && !_previewMode; }

/* ─── Tab / Section Utilities ───────────────────────────────── */
function getActiveTab() { return _tabs.find(t => t.id === _activeTabId) || _tabs[0]; }

function getAllUsedSections() {
  const keys = new Set();
  _tabs.forEach(t => (t.sections || []).forEach(s => keys.add(s.key)));
  return keys;
}

function tabsToSections() {
  const keys = [];
  _tabs.forEach(t => (t.sections || []).forEach(s => { if (!keys.includes(s.key)) keys.push(s.key); }));
  return keys;
}

function findWidgetById(id) {
  const tab = getActiveTab();
  if (!tab) return null;
  for (const sec of (tab.sections || [])) {
    const w = (sec.widgets || []).find(w => w.id === id);
    if (w) return w;
  }
  return null;
}

function findSectionForWidget(widgetId) {
  const tab = getActiveTab();
  if (!tab) return null;
  for (const sec of (tab.sections || [])) {
    if ((sec.widgets || []).some(w => w.id === widgetId)) return sec;
  }
  return null;
}

function findSectionById(sectionId) {
  for (const tab of _tabs) {
    const sec = (tab.sections || []).find(s => s.id === sectionId);
    if (sec) return sec;
  }
  return null;
}

/* ─── Migration from legacy formats ─────────────────────────── */
function migrateLegacy(schedule) {
  // Ensure every section has name, collapsed, content, storagePath fields
  function ensureSectionFields(sec, schedule) {
    const reg = SECTION_REG[sec.key];
    if (!sec.name) sec.name = reg?.label || sec.key;
    if (sec.collapsed === undefined) sec.collapsed = false;
    // Migrate text content from schedule-level fields to per-section
    if ((reg?.component === 'text' || reg?.component === 'richtext') && sec.content === undefined) {
      sec.content = schedule[reg.field] || '';
    }
    // Migrate file storage path
    if (reg?.component === 'files' && !sec.storagePath) {
      sec.storagePath = reg.path || sec.key;
    }
    return sec;
  }

  if (schedule.tabs && schedule.tabs.length) {
    const tabs = JSON.parse(JSON.stringify(schedule.tabs));
    tabs.forEach(tab => {
      (tab.sections || []).forEach(sec => ensureSectionFields(sec, schedule));
    });
    return tabs;
  }
  // Migrate from flat layout or sections array
  const layout = schedule.layout
    ? JSON.parse(JSON.stringify(schedule.layout))
    : (schedule.sections || ['overview']).map(key => ({ type: 'section', key, id: genBlockId() }));

  const sections = [];
  let current = null;
  for (const block of layout) {
    if (block.type === 'section') {
      current = { key: block.key, id: block.id || genBlockId(), widgets: [] };
      sections.push(current);
    } else if (block.type === 'widget') {
      if (!current) {
        current = { key: 'overview', id: genBlockId(), widgets: [] };
        sections.push(current);
      }
      const w = { ...block };
      delete w.type;
      if (!w.id) w.id = genBlockId();
      current.widgets.push(w);
    }
  }
  if (!sections.length) {
    sections.push({ key: 'overview', id: genBlockId(), widgets: [] });
  }
  sections.forEach(sec => ensureSectionFields(sec, schedule));
  return [{ id: genTabId(), name: 'Home', sections }];
}

/* ================================================================
   DATABASE
   ================================================================ */
const ScheduleDB = {
  async getSchedule(id) {
    const doc = await McgheeLab.db.collection('schedules').doc(id).get();
    return doc.exists ? { id: doc.id, ...doc.data() } : null;
  },
  async saveSchedule(data) {
    data.updatedAt = firebase.firestore.FieldValue.serverTimestamp();
    const id = data.id; const rest = Object.assign({}, data); delete rest.id;
    await McgheeLab.db.collection('schedules').doc(id).set(rest, { merge: true });
    return id;
  },
  async getSpeakers(scheduleId) {
    const snap = await McgheeLab.db.collection('participants')
      .where('scheduleId', '==', scheduleId).get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  },
  async getSpeakerByKey(key) {
    const doc = await McgheeLab.db.collection('participants').doc(key).get();
    return doc.exists ? { id: doc.id, ...doc.data() } : null;
  },
  async addSpeaker(data) {
    const key = generateKey();
    data.key = key;
    data.createdAt = firebase.firestore.FieldValue.serverTimestamp();
    data.updatedAt = firebase.firestore.FieldValue.serverTimestamp();
    await McgheeLab.db.collection('participants').doc(key).set(data);
    return key;
  },
  async updateSpeaker(id, data) {
    data.updatedAt = firebase.firestore.FieldValue.serverTimestamp();
    await McgheeLab.db.collection('participants').doc(id).update(data);
  },
  async updateSpeakerByKey(key, data) {
    data.key = key;
    data.updatedAt = firebase.firestore.FieldValue.serverTimestamp();
    await McgheeLab.db.collection('participants').doc(key).update(data);
  },
  async deleteSpeaker(id) {
    await McgheeLab.db.collection('participants').doc(id).delete();
  },
  async getFiles(classId, section) {
    const snap = await McgheeLab.db.collection('classFiles')
      .where('classId', '==', classId).where('section', '==', section).get();
    const files = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    files.sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
    return files;
  },
  async addFile(data) {
    data.createdAt = firebase.firestore.FieldValue.serverTimestamp();
    const ref = await McgheeLab.db.collection('classFiles').add(data);
    return ref.id;
  },
  async deleteFile(fileId, storagePath) {
    if (storagePath) {
      try { await firebase.storage().ref(storagePath).delete(); } catch (e) { console.warn('Storage delete failed:', e); }
    }
    await McgheeLab.db.collection('classFiles').doc(fileId).delete();
  }
};

async function resolveSchedule(scheduleId) {
  // V3.632 — demo mode serves its fixture classes (tc-demo-*) so the admin
  // preview exercises the real class page without provisioning anything.
  const demoSched = McgheeLab.TC_DEMO?.active ? McgheeLab.TC_DEMO.schedule(scheduleId) : null;
  if (demoSched) return demoSched;
  try {
    const remote = await ScheduleDB.getSchedule(scheduleId);
    if (remote) return remote;
  } catch (e) { /* fallback */ }
  return DEFAULT_SCHEDULES[scheduleId] || null;
}

/* ================================================================
   RENDER — sync shell (called from app.js)
   ================================================================ */
function renderClassPage(scheduleId) {
  scheduleId = scheduleId || 'bme295c';
  const sched = DEFAULT_SCHEDULES[scheduleId] || { title: 'Schedule', subtitle: '', semester: '', description: '' };
  return `
    <div class="class-page max-w" data-schedule-id="${esc(scheduleId)}">
      <div class="section card reveal">
        <div class="class-header">
          <div class="cb-header-row">
            <a href="#/classes" class="class-back-link">&larr; All Classes</a>
            <div class="cb-header-actions" id="cb-header-actions"></div>
          </div>
          <h2 id="sched-title">${esc(sched.title)}</h2>
          <p class="class-subtitle" id="sched-subtitle">${esc(sched.subtitle || '')}${sched.semester ? ' &mdash; ' + esc(sched.semester) : ''}</p>
        </div>
      </div>
      <div id="class-page-content"><p class="muted-text" style="padding:2rem;text-align:center;">Loading...</p></div>
    </div>
  `;
}

/* ================================================================
   WIRE — async data load + canvas build
   ================================================================ */
async function wireClassPage(scheduleId) {
  scheduleId = scheduleId || 'bme295c';
  _scheduleId = scheduleId;
  cleanupListeners();

  const Auth = McgheeLab.Auth;
  const isGlobalAdmin = Auth?.currentProfile?.role === 'admin';
  let isAdmin = isGlobalAdmin;
  const isLoggedIn = !!Auth?.currentUser;
  const inviteKey = getInviteKeyFromURL();

  let schedule = await resolveSchedule(scheduleId);
  if (!schedule) {
    const c = document.getElementById('class-page-content');
    if (c) c.innerHTML = '<p class="muted-text">Schedule not found.</p>';
    return;
  }

  // V3.304 — external teacher classes get the simplified, enrollment-gated
  // page from teacher-classes.js instead of the tabs/widgets engine.
  if (schedule.kind === 'teacher-class' && McgheeLab.wireTeacherClassPage) {
    return McgheeLab.wireTeacherClassPage(scheduleId, schedule);
  }

  // V3.247 — elevate to admin if the signed-in user's email is on this
  // schedule's `classAdminEmails` list. Lets the course owner delegate
  // class-admin rights (roster editing, auto-assign, test students) to
  // a couple of assistants without granting them global admin role.
  // Firestore rules enforce the same gate server-side.
  const _userEmail = (Auth?.currentUser?.email || '').toLowerCase();
  const _classAdminList = Array.isArray(schedule.classAdminEmails)
    ? schedule.classAdminEmails.map(e => (e || '').toLowerCase())
    : [];
  const isClassAdmin = !!_userEmail && _classAdminList.includes(_userEmail);
  if (isClassAdmin) isAdmin = true;
  _isClassAdminOnly = isClassAdmin && !isGlobalAdmin;

  // V3.681 — narrow course staff (TA). Does NOT set isAdmin: it opens the
  // staffOnly tabs and nothing else. A global admin / class admin counts as
  // course staff too, so staff-only code can test one flag.
  const _courseStaffList = Array.isArray(schedule.courseStaffEmails)
    ? schedule.courseStaffEmails.map(e => (e || '').toLowerCase())
    : [];
  _isCourseStaff = isAdmin || (!!_userEmail && _courseStaffList.includes(_userEmail));
  _realIsCourseStaff = _isCourseStaff;

  // V3.248 — remember the "real" admin status before applying the View-as
  // override, so the toolbar stays visible while the rest of the page
  // renders as a public / student preview.
  _realIsAdmin = isAdmin;
  _realIsClassAdminOnly = _isClassAdminOnly;
  if (_adminViewOverride) {
    if (_adminViewOverride.type === 'public') {
      isAdmin = false;
      _isClassAdminOnly = false;
      _isCourseStaff = false;      // V3.681 — a public preview must hide the staff tab too
    } else if (_adminViewOverride.type === 'student') {
      isAdmin = false;
      _isClassAdminOnly = false;
      _isCourseStaff = false;
    }
  }

  // Seed default on first admin visit
  if (isAdmin && DEFAULT_SCHEDULES[scheduleId] && !schedule.updatedAt) {
    const seed = Object.assign({}, DEFAULT_SCHEDULES[scheduleId]);
    if (!seed.ownerUid && Auth.currentUser) seed.ownerUid = Auth.currentUser.uid;
    try { await ScheduleDB.saveSchedule(seed); schedule = await resolveSchedule(scheduleId); } catch (e) {}
  }

  // V3.244 migration: rewrite legacy bme295c docs with the new 3-tab layout.
  // Triggered if the persisted schedule predates the BME 295C tabs (no
  // checkin295c section present) — preserves ownerUid and any populated
  // studentRoster.
  if (isAdmin && scheduleId === 'bme295c') {
    const hasNewLayout = (schedule.tabs || []).some(t =>
      (t.sections || []).some(s => s.key === 'checkin295c')
    );
    if (!hasNewLayout) {
      const seed = Object.assign({}, DEFAULT_SCHEDULES['bme295c']);
      seed.ownerUid = schedule.ownerUid || Auth.currentUser?.uid || null;
      if (Array.isArray(schedule.studentRoster) && schedule.studentRoster.length) {
        seed.studentRoster = schedule.studentRoster;
      }
      try { await ScheduleDB.saveSchedule(seed); schedule = await resolveSchedule(scheduleId); } catch (e) { console.warn('[BME295C] migration save failed', e); }
    }
  }

  // V3.245 migration: backfill email / campus / highSchool from the seed
  // for any roster entry where those fields are still blank, and append any
  // seed students whose Empl ID isn't on the persisted roster yet (Kopp,
  // Ung). Admin-entered values take precedence — we only fill empties.
  if (isAdmin && scheduleId === 'bme295c' && Array.isArray(schedule.studentRoster)) {
    const seedRoster = DEFAULT_SCHEDULES['bme295c'].studentRoster || [];
    const seedById = new Map(seedRoster.map(s => [s.id, s]));
    let changed = false;
    const merged = schedule.studentRoster.map(entry => {
      const seed = seedById.get(entry.id);
      if (!seed) return entry;
      const next = { ...entry };
      if (!next.email      && seed.email)      { next.email      = seed.email;      changed = true; }
      if (!next.campus     && seed.campus)     { next.campus     = seed.campus;     changed = true; }
      if (!next.highSchool && seed.highSchool) { next.highSchool = seed.highSchool; changed = true; }
      if (!next.pronouns   && seed.pronouns)   { next.pronouns   = seed.pronouns;   changed = true; }
      return next;
    });
    const persistedIds = new Set(merged.map(s => s.id));
    seedRoster.forEach(s => {
      if (!persistedIds.has(s.id)) { merged.push({ ...s }); changed = true; }
    });
    if (changed) {
      try {
        await ScheduleDB.saveSchedule({ ...schedule, studentRoster: merged });
        schedule = await resolveSchedule(scheduleId);
      } catch (e) { console.warn('[BME295C] roster backfill failed', e); }
    }
  }

  // V3.249 migration: strip the legacy `roster295c` section from any
  // tab — roster management is now on the Admin Dashboard tab.
  if (isAdmin && scheduleId === 'bme295c' && Array.isArray(schedule.tabs)) {
    let changed = false;
    const cleaned = schedule.tabs.map(t => {
      const sections = (t.sections || []).filter(s => s.key !== 'roster295c');
      if (sections.length !== (t.sections || []).length) changed = true;
      return { ...t, sections };
    });
    if (changed) {
      try {
        await ScheduleDB.saveSchedule({ ...schedule, tabs: cleaned });
        schedule = await resolveSchedule(scheduleId);
      } catch (e) { console.warn('[BME295C] roster section strip failed', e); }
    }
  }

  // V3.248 migration: ensure the Admin Dashboard tab exists on the
  // persisted schedule doc. Appended after Learning Modules if missing.
  if (isAdmin && scheduleId === 'bme295c' && Array.isArray(schedule.tabs)) {
    const hasDashTab = schedule.tabs.some(t =>
      (t.sections || []).some(s => s.key === 'adminDash295c'));
    if (!hasDashTab) {
      const seedDashTab = DEFAULT_SCHEDULES['bme295c'].tabs.find(t =>
        (t.sections || []).some(s => s.key === 'adminDash295c'));
      if (seedDashTab) {
        const newTabs = [...schedule.tabs, JSON.parse(JSON.stringify(seedDashTab))];
        try {
          await ScheduleDB.saveSchedule({ ...schedule, tabs: newTabs });
          schedule = await resolveSchedule(scheduleId);
        } catch (e) { console.warn('[BME295C] admin-tab migration failed', e); }
      }
    }
  }

  // V3.674 migration: ensure the BME466 Dashboard tab (hwDash466) exists on
  // an already-seeded bme466 schedule doc. Appended after Learning Modules.
  if (isAdmin && scheduleId === 'bme466' && Array.isArray(schedule.tabs)) {
    const hasHwDash = schedule.tabs.some(t =>
      (t.sections || []).some(s => s.key === 'hwDash466'));
    if (!hasHwDash) {
      const seedTab = DEFAULT_SCHEDULES['bme466'].tabs.find(t =>
        (t.sections || []).some(s => s.key === 'hwDash466'));
      if (seedTab) {
        const newTabs = [...schedule.tabs, JSON.parse(JSON.stringify(seedTab))];
        try {
          await ScheduleDB.saveSchedule({ ...schedule, tabs: newTabs });
          schedule = await resolveSchedule(scheduleId);
        } catch (e) { console.warn('[BME466] dashboard-tab migration failed', e); }
      }
    }
  }

  // V3.677 migration: ensure the BME466 Whiteboard tab exists on an
  // already-seeded bme466 schedule doc (the seed edit alone is invisible
  // once the doc lives in Firestore — resolveSchedule prefers Firestore).
  // Same pattern as the V3.674 dashboard-tab migration above.
  if (isAdmin && scheduleId === 'bme466' && Array.isArray(schedule.tabs)) {
    const hasWhiteboard = schedule.tabs.some(t =>
      (t.sections || []).some(s => s.key === 'whiteboard'));
    if (!hasWhiteboard) {
      const seedTab = DEFAULT_SCHEDULES['bme466'].tabs.find(t =>
        (t.sections || []).some(s => s.key === 'whiteboard'));
      if (seedTab) {
        const newTabs = [...schedule.tabs, JSON.parse(JSON.stringify(seedTab))];
        try {
          await ScheduleDB.saveSchedule({ ...schedule, tabs: newTabs });
          schedule = await resolveSchedule(scheduleId);
        } catch (e) { console.warn('[BME466] whiteboard-tab migration failed', e); }
      }
    }
  }

  // V3.674 migration: ensure the pretest module row exists on an
  // already-seeded bme466 schedule doc (published — it goes live in W1).
  if (isAdmin && scheduleId === 'bme466' && Array.isArray(schedule.modules)) {
    const hasPretest = schedule.modules.some(m => m.htmlFile === 'hw-00-pretest.html');
    if (!hasPretest) {
      const seedMod = DEFAULT_SCHEDULES['bme466'].modules.find(m =>
        m.htmlFile === 'hw-00-pretest.html');
      if (seedMod) {
        const newModules = [JSON.parse(JSON.stringify(seedMod)), ...schedule.modules];
        try {
          await ScheduleDB.saveSchedule({ ...schedule, modules: newModules });
          schedule = await resolveSchedule(scheduleId);
        } catch (e) { console.warn('[BME466] pretest-module migration failed', e); }
      }
    }
  }

  /* V3.777 migration: HW2 ("Reading and Building", Weeks 3–4) on an
     already-seeded bme466 doc — two module rows and the assignment row.

     Why a migration and not the seed: HW466_SEED_ASSIGNMENTS only runs when
     the assignments collection is EMPTY (hw466SeedAssignments bails if any
     doc exists), so a row added to that array after HW0/HW1 were seeded is
     never written. Same for schedule.modules — DEFAULT_SCHEDULES seeds a new
     doc, not an existing one. The pretest migration above is the pattern.

     The assignment is created as a DRAFT on purpose. functions/bme466-notify.js
     fans out to every student profile on the transition into published:true —
     and creating a doc already published IS that transition (its `before` is
     undefined). Publishing before the module files are on the server would
     notify the class and hand them a 404. So: this migration fills the row in,
     the instructor FTPs, then flips Publish in Assignments & Requests, which
     carries its own confirmation. */
  if (isAdmin && scheduleId === 'bme466') {
    if (Array.isArray(schedule.modules)) {
      const wantHw2 = ['hw2-reading-and-building.html', 'hw-02-reading-and-building.html'];
      const missing = wantHw2.filter(f => !schedule.modules.some(m => m.htmlFile === f));
      if (missing.length) {
        const seedRows = missing
          .map(f => DEFAULT_SCHEDULES['bme466'].modules.find(m => m.htmlFile === f))
          .filter(Boolean)
          .map(m => JSON.parse(JSON.stringify(m)));
        if (seedRows.length) {
          try {
            await ScheduleDB.saveSchedule({ ...schedule, modules: [...schedule.modules, ...seedRows] });
            schedule = await resolveSchedule(scheduleId);
          } catch (e) { console.warn('[BME466] hw2-module migration failed', e); }
        }
      }
    }
    try {
      const ref = hw466Col().collection('assignments').doc('hw2');
      const existing = await ref.get();
      if (!existing.exists) {
        const seed = HW466_SEED_ASSIGNMENTS.find(a => a.slug === 'hw2');
        if (seed) {
          await ref.set({
            ...seed,
            published: false,                         // the instructor publishes; see above
            dueAt: Date.parse('2026-09-30T23:59:00'),
            createdAt: hw466Now(), createdBy: hw466MyEmail(),
            updatedAt: hw466Now(), updatedBy: hw466MyEmail()
          });
          await hw466SyncProgressKeys();              // adds bme466-hw2, no rules deploy
          console.log('[BME466] HW2 assignment row created as a draft — publish it in Assignments & Requests once the files are on the server');
        }
      }
    } catch (e) { console.warn('[BME466] hw2-assignment migration failed', e); }
  }

  /* V3.778 migration: Report 1 ("Read & Rebuild") on an already-seeded bme466
     doc — the module row, and the module link on the assignment row.

     Report 1 differs from the V3.777 HW2 case in the one way that matters:
     the `report-1` assignment document ALREADY EXISTS. The V3.681 inventory
     seed wrote it as a bare draft with no moduleUrl and no progressKey, so
     HW2's create-if-absent pattern would do nothing here and the row would
     stay unlinked — visible in the list, with no way to open the module and
     no progress for the student dashboard to read. This migration therefore
     FILLS IN the missing fields on the existing draft, and still creates the
     row if it is somehow absent.

     It never writes `published`, and never touches `dueAt` or `title` — an
     instructor may already have set those by hand. Publishing stays theirs,
     in Assignments & Requests, after the FTP: functions/bme466-notify.js fans
     out to every student profile on the transition into published:true, so
     publishing before the file is on the server would notify the class and
     hand them a 404. Leaving `published` out of the merge also means this
     migration cannot fire that notification however many times it runs.

     Rules path (firestore.rules, schedules/bme466/assignments/{slug}): a merge
     write is validated as the MERGED document, so hasAll is satisfied by the
     existing fields; every key written here is on the hasOnly whitelist;
     updatedAt is a server timestamp (== request.time) and updatedBy is the
     token email. allow update: bme466Staff() && aShapeOk(). */
  if (isAdmin && scheduleId === 'bme466') {
    if (Array.isArray(schedule.modules)) {
      const wantR1 = 'report-01-journal-review.html';
      if (!schedule.modules.some(m => m.htmlFile === wantR1)) {
        const row = DEFAULT_SCHEDULES['bme466'].modules.find(m => m.htmlFile === wantR1);
        if (row) {
          try {
            await ScheduleDB.saveSchedule({
              ...schedule, modules: [...schedule.modules, JSON.parse(JSON.stringify(row))]
            });
            schedule = await resolveSchedule(scheduleId);
          } catch (e) { console.warn('[BME466] report-1 module migration failed', e); }
        }
      }
    }
    try {
      const seed = HW466_SEED_ASSIGNMENTS.find(a => a.slug === 'report-1');
      const ref = hw466Col().collection('assignments').doc('report-1');
      const existing = await ref.get();
      if (seed && !existing.exists) {
        await ref.set({
          ...seed,
          published: false,                           // the instructor publishes; see above
          createdAt: hw466Now(), createdBy: hw466MyEmail(),
          updatedAt: hw466Now(), updatedBy: hw466MyEmail()
        });
        await hw466SyncProgressKeys();                // adds bme466-report1, no rules deploy
        console.log('[BME466] Report 1 assignment row created as a draft — publish it in Assignments & Requests once the file is on the server');
      } else if (seed && existing.exists) {
        const d = existing.data() || {};
        const patch = {};
        if (!d.moduleUrl)   patch.moduleUrl   = seed.moduleUrl;
        if (!d.progressKey) patch.progressKey = seed.progressKey;
        if (!d.notes)       patch.notes       = seed.notes;
        if (Object.keys(patch).length) {
          patch.updatedAt = hw466Now();               // rules require == request.time
          patch.updatedBy = hw466MyEmail();
          await ref.update(patch);                    // `published` deliberately absent
          await hw466SyncProgressKeys();              // adds bme466-report1, no rules deploy
          console.log('[BME466] Report 1 assignment row linked to its module — publish it in Assignments & Requests once the file is on the server');
        }
      }
    } catch (e) { console.warn('[BME466] report-1 assignment migration failed', e); }
  }

  /* V3.798 migration: HW3 ("Grip and Ground", Weeks 5–6) on an already-seeded
     bme466 doc — the module row and the assignment row (V3.800: one module row;
     the "read first" prompt page was taken off the site). The Report 1 case
     (V3.778), not the HW2 one: the V3.681 inventory seed wrote `hw3` as a bare
     draft (title 'HW3', progressKey only), so create-if-absent alone would leave
     it unlinked. This FILLS IN what is missing and creates the row only if it is
     somehow absent.

     Never written: `published` (the instructor publishes after the FTP —
     functions/bme466-notify.js fans out to every student on the transition into
     published:true); `dueAt`/`opensAt` when already set (an instructor may have
     typed real dates); `title` unless it is still the seed placeholder 'HW3'.
     The module rows arrive with Visible unticked for the same reason.
     Rules path as V3.778: merged-document validation, whitelisted keys only,
     updatedAt == request.time, updatedBy = token email. */
  if (isAdmin && scheduleId === 'bme466') {
    if (Array.isArray(schedule.modules)) {
      const wantHw3 = ['hw-03-grip-and-ground.html'];
      const missing = wantHw3.filter(f => !schedule.modules.some(m => m.htmlFile === f));
      if (missing.length) {
        const seedRows = missing
          .map(f => DEFAULT_SCHEDULES['bme466'].modules.find(m => m.htmlFile === f))
          .filter(Boolean)
          .map(m => JSON.parse(JSON.stringify(m)));
        if (seedRows.length) {
          try {
            await ScheduleDB.saveSchedule({ ...schedule, modules: [...schedule.modules, ...seedRows] });
            schedule = await resolveSchedule(scheduleId);
          } catch (e) { console.warn('[BME466] hw3-module migration failed', e); }
        }
      }
    }
    try {
      const seed = HW466_SEED_ASSIGNMENTS.find(a => a.slug === 'hw3');
      const ref = hw466Col().collection('assignments').doc('hw3');
      const existing = await ref.get();
      const opens = Date.parse('2026-10-06T00:00:00');
      const due = Date.parse('2026-10-20T23:59:00');
      if (seed && !existing.exists) {
        await ref.set({
          ...seed,
          published: false,                           // the instructor publishes; see above
          opensAt: opens, dueAt: due,
          createdAt: hw466Now(), createdBy: hw466MyEmail(),
          updatedAt: hw466Now(), updatedBy: hw466MyEmail()
        });
        await hw466SyncProgressKeys();                // bme466-hw3 is also in the legacy rules list
        console.log('[BME466] HW3 assignment row created as a draft — publish it in Assignments & Requests once the files are on the server');
      } else if (seed && existing.exists) {
        const d = existing.data() || {};
        const patch = {};
        if (!d.moduleUrl)   patch.moduleUrl   = seed.moduleUrl;
        if (!d.progressKey) patch.progressKey = seed.progressKey;
        if (!d.notes)       patch.notes       = seed.notes;
        if (!d.title || d.title === 'HW3') patch.title = seed.title;
        if (!d.opensAt)     patch.opensAt     = opens;
        if (!d.dueAt)       patch.dueAt       = due;
        if (Object.keys(patch).length) {
          patch.updatedAt = hw466Now();               // rules require == request.time
          patch.updatedBy = hw466MyEmail();
          await ref.update(patch);                    // `published` deliberately absent
          await hw466SyncProgressKeys();
          console.log('[BME466] HW3 assignment row linked to its module — publish it in Assignments & Requests once the files are on the server');
        }
      }
    } catch (e) { console.warn('[BME466] hw3 assignment migration failed', e); }
  }

  /* V3.681 migration: the three course-platform tabs (Homeworks, My
     Homework, Assignments & Requests) + the courseStaffEmails field, on an
     already-seeded bme466 doc. The new tabs are inserted BEFORE the
     admin-only Dashboard tab so the tab bar reads
     public → student → staff → admin left to right. Runs once; each piece is
     independently idempotent, so a partial failure retries next visit. */
  if (isAdmin && scheduleId === 'bme466' && Array.isArray(schedule.tabs)) {
    const wanted = ['hwList466', 'hwMine466', 'hwAssign466'];
    const missing = wanted.filter(k =>
      !schedule.tabs.some(t => (t.sections || []).some(s => s.key === k)));
    const needsStaffField = !Array.isArray(schedule.courseStaffEmails);
    if (missing.length || needsStaffField) {
      const seeds = missing
        .map(k => DEFAULT_SCHEDULES['bme466'].tabs.find(t =>
          (t.sections || []).some(s => s.key === k)))
        .filter(Boolean)
        .map(t => JSON.parse(JSON.stringify(t)));
      const dashIdx = schedule.tabs.findIndex(t =>
        (t.sections || []).some(s => s.key === 'hwDash466'));
      const at = dashIdx === -1 ? schedule.tabs.length : dashIdx;
      const newTabs = [...schedule.tabs.slice(0, at), ...seeds, ...schedule.tabs.slice(at)];
      try {
        await ScheduleDB.saveSchedule({
          ...schedule,
          tabs: newTabs,
          courseStaffEmails: Array.isArray(schedule.courseStaffEmails)
            ? schedule.courseStaffEmails : []
        });
        schedule = await resolveSchedule(scheduleId);
      } catch (e) { console.warn('[BME466] V3.681 tab migration failed', e); }
    }
  }
  /* V3.681: seed the F26 assignment inventory as UNPUBLISHED drafts if the
     subcollection is empty, and derive hwProgressKeys from it. Dates are
     left blank on purpose — D2L is the authority on deadlines and no repo
     file holds real F26 dates, so the instructor fills them in. */
  if (isAdmin && scheduleId === 'bme466') {
    try { await hw466SeedAssignments(); }
    catch (e) { console.warn('[BME466] assignment seed failed', e); }
  }

  // V3.251 migration: ensure the chat tab exists. Inserted right
  // before the Admin Dashboard tab (or appended if dashboard is absent).
  if (isAdmin && scheduleId === 'bme295c' && Array.isArray(schedule.tabs)) {
    const hasChatTab = schedule.tabs.some(t =>
      (t.sections || []).some(s => s.key === 'chat295c'));
    if (!hasChatTab) {
      const seedChatTab = DEFAULT_SCHEDULES['bme295c'].tabs.find(t =>
        (t.sections || []).some(s => s.key === 'chat295c'));
      if (seedChatTab) {
        const adminIdx = schedule.tabs.findIndex(t =>
          (t.sections || []).some(s => s.key === 'adminDash295c'));
        const insertAt = adminIdx === -1 ? schedule.tabs.length : adminIdx;
        const newTabs = [
          ...schedule.tabs.slice(0, insertAt),
          JSON.parse(JSON.stringify(seedChatTab)),
          ...schedule.tabs.slice(insertAt)
        ];
        try {
          await ScheduleDB.saveSchedule({ ...schedule, tabs: newTabs });
          schedule = await resolveSchedule(scheduleId);
        } catch (e) { console.warn('[BME295C] chat-tab migration failed', e); }
      }
    }
  }

  // V3.286 migration — ensure the Course Assessment tab exists. Inserted
  // right before the Admin Dashboard tab (or appended if dashboard is
  // absent). Same shape as the V3.251 chat-tab migration above.
  if (isAdmin && scheduleId === 'bme295c' && Array.isArray(schedule.tabs)) {
    const hasAssessTab = schedule.tabs.some(t =>
      (t.sections || []).some(s => s.key === 'assessment295c'));
    if (!hasAssessTab) {
      const seedAssessTab = DEFAULT_SCHEDULES['bme295c'].tabs.find(t =>
        (t.sections || []).some(s => s.key === 'assessment295c'));
      if (seedAssessTab) {
        const adminIdx = schedule.tabs.findIndex(t =>
          (t.sections || []).some(s => s.key === 'adminDash295c'));
        const insertAt = adminIdx === -1 ? schedule.tabs.length : adminIdx;
        const newTabs = [
          ...schedule.tabs.slice(0, insertAt),
          JSON.parse(JSON.stringify(seedAssessTab)),
          ...schedule.tabs.slice(insertAt)
        ];
        try {
          await ScheduleDB.saveSchedule({ ...schedule, tabs: newTabs });
          schedule = await resolveSchedule(scheduleId);
        } catch (e) { console.warn('[BME295C] assessment-tab migration failed', e); }
      }
    }
  }

  // V3.269 migration — initialize an empty `discussionState` map on the
  // schedule doc so future writes have somewhere to merge into. The
  // helper `bmeGetDiscussionState` defaults missing entries to
  // 'pending', so we don't pre-populate per-speaker keys. Idempotent —
  // only writes when the field is entirely missing.
  if (isAdmin && scheduleId === 'bme295c' && !schedule.discussionState) {
    try {
      await ScheduleDB.saveSchedule({ ...schedule, discussionState: {} });
      schedule = await resolveSchedule(scheduleId);
    } catch (e) { console.warn('[BME295C] discussionState init failed', e); }
  }

  // V3.286 migration — initialize `assessmentState` to 'closed'. Admin
  // flips to 'open' when ready (end of day Friday) so students see the
  // form; then 'locked' once feedback collection is done. Idempotent.
  if (isAdmin && scheduleId === 'bme295c' && !schedule.assessmentState) {
    try {
      await ScheduleDB.saveSchedule({ ...schedule, assessmentState: 'closed' });
      schedule = await resolveSchedule(scheduleId);
    } catch (e) { console.warn('[BME295C] assessmentState init failed', e); }
  }

  // V3.272 migration — same shape, for the per-speaker YouTube link
  // map. Empty object means "no videos yet"; admin populates per
  // speaker via the Talk videos dashboard card.
  if (isAdmin && scheduleId === 'bme295c' && !schedule.speakerVideos) {
    try {
      await ScheduleDB.saveSchedule({ ...schedule, speakerVideos: {} });
      schedule = await resolveSchedule(scheduleId);
    } catch (e) { console.warn('[BME295C] speakerVideos init failed', e); }
  }

  // V3.279 migration — initialize an empty `dailyAttendance` map on the
  // schedule doc so future writes have somewhere to merge into.
  // Idempotent. Admin populates per day via the Daily attendance card.
  if (isAdmin && scheduleId === 'bme295c' && !schedule.dailyAttendance) {
    try {
      await ScheduleDB.saveSchedule({ ...schedule, dailyAttendance: {} });
      schedule = await resolveSchedule(scheduleId);
    } catch (e) { console.warn('[BME295C] dailyAttendance init failed', e); }
  }

  // V3.280 migration — seed `grades` with default weights + empty
  // sub-maps. Idempotent — only writes when the field is entirely
  // missing. Helper `bmeGetGradesObj` also backfills missing sub-maps
  // defensively on every read, so a partially-written doc still
  // works at render time.
  if (isAdmin && scheduleId === 'bme295c' && !schedule.grades) {
    try {
      await ScheduleDB.saveSchedule({ ...schedule, grades: {
        weights: { attendance: 40, discussion: 30, alertness: 30 },
        alertness: {}, discussionQuality: {}, comments: {}, excused: {}
      }});
      schedule = await resolveSchedule(scheduleId);
    } catch (e) { console.warn('[BME295C] grades init failed', e); }
  }

  // V3.281 migration — alertness key shape changed from speakerSlug to
  // day name. Any pre-V3.281 entries (keyed by slug) are no longer
  // readable by the new helpers and would just pollute the doc. Prune
  // any alertness top-level keys that aren't recognized course day
  // names. Idempotent: a doc with only day-keyed entries is unchanged.
  if (isAdmin && scheduleId === 'bme295c' && schedule.grades?.alertness) {
    const validDays = new Set(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']);
    const cur = schedule.grades.alertness;
    const next = {};
    let changed = false;
    Object.keys(cur).forEach(k => {
      if (validDays.has(k)) next[k] = cur[k];
      else changed = true;
    });
    if (changed) {
      try {
        await ScheduleDB.saveSchedule({
          ...schedule,
          grades: { ...schedule.grades, alertness: next }
        });
        schedule = await resolveSchedule(scheduleId);
      } catch (e) { console.warn('[BME295C] V3.281 alertness reshape failed', e); }
    }
  }

  // V3.258 — rename existing "Live Q&A" tab + section to "Course Chat"
  // on legacy schedule docs. V3.257 renamed the seed + UI strings; this
  // companion migration covers schedule docs already persisted with the
  // old name on their `tabs[].name` / `sections[].name`. Idempotent:
  // only rewrites entries whose name still matches the V3.251–V3.256
  // label.
  if (isAdmin && scheduleId === 'bme295c' && Array.isArray(schedule.tabs)) {
    const LIVE_QA_NAMES = new Set(['Live Q&A', 'Live Q&amp;A']);
    let changed = false;
    const renamedTabs = schedule.tabs.map(t => {
      let tabChanged = false;
      let nextTab = t;
      if (LIVE_QA_NAMES.has(t.name)) {
        nextTab = { ...nextTab, name: 'Course Chat' };
        tabChanged = true;
      }
      const sections = (nextTab.sections || []).map(s => {
        if (s.key === 'chat295c' && LIVE_QA_NAMES.has(s.name)) {
          tabChanged = true;
          return { ...s, name: 'Course Chat' };
        }
        return s;
      });
      if (tabChanged) {
        changed = true;
        return { ...nextTab, sections };
      }
      return t;
    });
    if (changed) {
      try {
        await ScheduleDB.saveSchedule({ ...schedule, tabs: renamedTabs });
        schedule = await resolveSchedule(scheduleId);
      } catch (e) { console.warn('[BME295C] chat-tab rename failed', e); }
    }
  }

  // V3.246 migration: ensure each roster entry has a `dailyGroups` map.
  // If a legacy `groupNumber` exists, mirror it across all course days so
  // the dashboard renders something on first load; admin can re-roll
  // rotation via "Auto-assign daily groups" anytime.
  if (isAdmin && scheduleId === 'bme295c' && Array.isArray(schedule.studentRoster)) {
    const courseDays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
    let changed = false;
    const migrated = schedule.studentRoster.map(entry => {
      const hasDaily = entry.dailyGroups && typeof entry.dailyGroups === 'object' &&
        courseDays.some(d => typeof entry.dailyGroups[d] === 'number');
      if (hasDaily) return entry;
      const next = { ...entry, dailyGroups: { ...(entry.dailyGroups || {}) } };
      if (typeof entry.groupNumber === 'number') {
        courseDays.forEach(d => { next.dailyGroups[d] = entry.groupNumber; });
        changed = true;
      } else if (!entry.dailyGroups) {
        next.dailyGroups = {};
        changed = true;
      }
      return next;
    });
    if (changed) {
      try {
        await ScheduleDB.saveSchedule({ ...schedule, studentRoster: migrated });
        schedule = await resolveSchedule(scheduleId);
      } catch (e) { console.warn('[BME295C] dailyGroups migration failed', e); }
    }
  }

  // Update header
  const titleEl = document.getElementById('sched-title');
  const subtitleEl = document.getElementById('sched-subtitle');
  if (titleEl) titleEl.textContent = schedule.title || 'Schedule';
  if (subtitleEl) subtitleEl.innerHTML = esc(schedule.subtitle || '') + (schedule.semester ? ' &mdash; ' + esc(schedule.semester) : '');

  // Load speakers
  let speakers = [];
  try { speakers = await ScheduleDB.getSpeakers(scheduleId); } catch (e) {}

  // Auto-link UID
  if (isLoggedIn && Auth.currentUser.email) {
    const email = Auth.currentUser.email.toLowerCase();
    for (const sp of speakers) {
      if (sp.speakerEmail?.toLowerCase() === email && !sp.speakerUid) {
        try { await ScheduleDB.updateSpeaker(sp.id, { speakerUid: Auth.currentUser.uid }); sp.speakerUid = Auth.currentUser.uid; } catch (e) {}
      }
    }
  }

  // Identify current speaker
  let currentSpeaker = null, useKeyAuth = false;
  if (inviteKey) {
    currentSpeaker = speakers.find(s => s.id === inviteKey || s.key === inviteKey);
    if (!currentSpeaker) try { currentSpeaker = await ScheduleDB.getSpeakerByKey(inviteKey); } catch (e) {}
    if (currentSpeaker) useKeyAuth = true;
  }
  if (!currentSpeaker && isLoggedIn) {
    currentSpeaker = speakers.find(s =>
      s.speakerUid === Auth.currentUser.uid ||
      s.speakerEmail?.toLowerCase() === Auth.currentUser.email?.toLowerCase()
    );
  }

  // V3.248 — when the View-as override is active, treat as not-a-speaker
  // too (otherwise a real admin who's also a registered speaker would
  // land in `guest` view rather than `public`).
  if (_adminViewOverride) {
    currentSpeaker = null;
    useKeyAuth = false;
  }

  // Store state
  _classData = schedule;
  _speakers = speakers;
  _currentSpeaker = currentSpeaker;
  _useKeyAuth = useKeyAuth;
  _viewType = isAdmin ? 'admin' : (currentSpeaker ? 'guest' : 'public');
  _previewMode = false;

  // Resolve tabs (tabs field or migrate from layout/sections)
  _tabs = migrateLegacy(schedule);
  _activeTabId = _tabs[0]?.id || null;
  // V3.716 — assign every module entry to a Learning Modules section. Needs
  // _tabs, so it runs here rather than inside migrateLegacy; also covers the
  // public/student render, which never calls refreshCanvas().
  ensureModulePlacements();
  // V3.803 — type every untyped entry from its file name / title, then give
  // typed entries (homework, keys, reports, tests) the tab that lists them —
  // for the public/student render too.
  ensureModuleTypes();
  ensureTypedModuleTabs();

  // Pre-load file data for ALL file-type sections across ALL tabs
  _fileData = {};
  const fileSections = [];
  _tabs.forEach(tab => {
    (tab.sections || []).forEach(sec => {
      if (SECTION_REG[sec.key]?.component === 'files') fileSections.push(sec);
    });
  });
  await Promise.all(fileSections.map(async (sec) => {
    const path = sec.storagePath || SECTION_REG[sec.key]?.path || sec.key;
    try { _fileData[sec.id] = await ScheduleDB.getFiles(_scheduleId, path); } catch (e) { _fileData[sec.id] = []; }
  }));

  // BME 295C (V3.244) — load static content + per-user profile if any
  // 295c section is present in this schedule.
  await loadBme295cData(schedule);

  // V3.285 — student-side onSnapshot on the schedule doc itself so admin
  // gate flips, daily-group auto-assigns, and roster edits reach the
  // browser within seconds. Admin view is excluded inside the helper —
  // admin's own writes already trigger refreshCanvas via persistAll.
  if (scheduleId === 'bme295c') {
    attachBmeScheduleListener();
  }

  // Header actions
  const hdrActions = document.getElementById('cb-header-actions');
  if (hdrActions && _viewType === 'admin') {
    hdrActions.innerHTML = `
      <span id="cb-autosave-status" class="cb-autosave-status cb-status-saved">Saved</span>
      <button type="button" id="cb-preview-btn" class="btn btn-small">Preview</button>
      <button type="button" id="cb-save-btn" class="btn btn-small">Save Now</button>
      <button type="button" id="cb-settings-btn" class="btn btn-small btn-secondary">Settings</button>
    `;
  }

  // V3.677 — "🔴 Whiteboard is live" banner: whiteboard.js watches this
  // schedule doc's liveWhiteboard field and shows the banner on any tab.
  // Attached for every class (its own narrow listener — deliberately NOT
  // folded into attachBmeScheduleListener's 295c splice logic).
  window.Whiteboard?.attachLiveBanner?.(scheduleId);

  // Build canvas
  const content = document.getElementById('class-page-content');
  if (!content) return;
  _dirty = false;
  content.innerHTML = buildCanvasHTML();
  wireCanvas();

  // Admin: autosave + header buttons + beforeunload
  if (_viewType === 'admin') {
    startAutosave();
    document.getElementById('cb-save-btn')?.addEventListener('click', () => persistAll());
    document.getElementById('cb-settings-btn')?.addEventListener('click', () => openSettings());
    document.getElementById('cb-preview-btn')?.addEventListener('click', () => togglePreview());
    _beforeUnloadHandler = (e) => { if (_dirty) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', _beforeUnloadHandler);
  }

  // Cleanup on navigate away
  _hashChangeHandler = () => {
    const hash = window.location.hash || '';
    if (!hash.includes('/classes/' + _scheduleId)) cleanupListeners();
  };
  window.addEventListener('hashchange', _hashChangeHandler);
}

function cleanupListeners() {
  if (_dirty) persistAll();
  stopAutosave();
  if (_hashChangeHandler) { window.removeEventListener('hashchange', _hashChangeHandler); _hashChangeHandler = null; }
  if (_beforeUnloadHandler) { window.removeEventListener('beforeunload', _beforeUnloadHandler); _beforeUnloadHandler = null; }
  // V3.251 — release the Live Q&A onSnapshot subscription so we don't
  // accrue listeners across page navigations.
  if (_bmeChatUnsub) { try { _bmeChatUnsub(); } catch (e) {} _bmeChatUnsub = null; }
  // V3.251 — same for the admin dashboard's live discussion monitor.
  detachBmeDashboardListener();
  // V3.285 — release the schedule-doc snapshot subscription.
  detachBmeScheduleListener();
  // V3.286 — release the assessments listener.
  detachBmeAssessmentsListener();
  // V3.677 — release the live-whiteboard banner listener + remove the banner.
  window.Whiteboard?.detachLiveBanner?.();
}

/** V3.251 — release the groupResponses snapshot subscription + the
 * timestamp-refresh interval. Called from cleanupListeners and any
 * time we exit/re-enter the admin dashboard tab.
 */
function detachBmeDashboardListener() {
  if (_bmeDashboardUnsub) {
    try { _bmeDashboardUnsub(); } catch (e) {}
    _bmeDashboardUnsub = null;
  }
  if (_bmeMonitorTickInterval) {
    clearInterval(_bmeMonitorTickInterval);
    _bmeMonitorTickInterval = null;
  }
}

/** V3.285 — schedule-doc onSnapshot. Splices admin-side flips (gate
 * state, attendance, daily groups, instructors, classAdminEmails,
 * testMode, speakerVideos, discussionState) into the live `_classData`
 * so students see them without a reload.
 *
 * Admin-side is excluded because admin's local edits already flow
 * through `persistAll()` + immediate `refreshCanvas()`; echoing those
 * back through onSnapshot would cause stutter and (worse) revert a
 * field mid-edit if Firestore round-trip beats the next keystroke.
 *
 * Fields we DON'T splice from the snapshot: `tabs`, `sections`,
 * `modules` (admin-editable structure that doesn't change mid-class)
 * and `grades` (admin-only; students never see it). If admin updates
 * those mid-session, students see them on next navigation.
 *
 * Idempotent: subsequent calls are no-ops if already attached.
 */
function attachBmeScheduleListener() {
  if (_bmeScheduleUnsub) return;
  if (_viewType === 'admin') return; // admin's own writes already trigger refreshCanvas
  try {
    _bmeScheduleUnsub = McgheeLab.db.collection('schedules').doc(_scheduleId)
      .onSnapshot((doc) => {
        if (!doc.exists || !_classData) return;
        const next = doc.data();
        // V3.285 — flush in-flight student keystrokes BEFORE the splice
        // + refreshCanvas() rebuild destroys the textareas. The
        // adversarial verification of V3.285 caught this as a data-loss
        // bug: 800ms autosave timer was unaffected by the snapshot, so
        // it fired AFTER the rebuild, read the now-stale rebuilt DOM
        // (rehydrated from `_bmeGroupResponses` cache, NOT from the
        // student's pending keystrokes), and overwrote the student's
        // text in Firestore. flushPendingResponseAutosaves clears every
        // pending timer, captures live DOM values into the cache so the
        // rebuild rehydrates with the in-flight text, and synchronously
        // schedules the actual write after refreshCanvas completes.
        flushPendingResponseAutosaves();
        // Whitelisted splice — only fields admin commonly flips mid-class.
        if (next.discussionState !== undefined)  _classData.discussionState = next.discussionState || {};
        if (next.dailyAttendance !== undefined)  _classData.dailyAttendance = next.dailyAttendance || {};
        if (Array.isArray(next.studentRoster))   _classData.studentRoster   = next.studentRoster;
        if (next.instructors !== undefined)      _classData.instructors     = next.instructors;
        if (Array.isArray(next.classAdminEmails)) _classData.classAdminEmails = next.classAdminEmails;
        if (next.testMode !== undefined)         _classData.testMode        = !!next.testMode;
        if (next.speakerVideos !== undefined)    _classData.speakerVideos   = next.speakerVideos || {};
        if (next.assessmentState !== undefined)  _classData.assessmentState = next.assessmentState || 'closed';
        // V3.285 — when the student's own roster row was edited (e.g.
        // admin auto-assigned Tuesday's groups), refresh _bmeRosterEntry
        // so the next save uses the new dailyGroups.
        const auth = McgheeLab.Auth;
        const myEmail = (auth?.currentUser?.email || '').toLowerCase();
        if (myEmail && Array.isArray(_classData.studentRoster)) {
          _bmeRosterEntry = _classData.studentRoster.find(r => (r.email || '').toLowerCase() === myEmail) || null;
        }
        refreshCanvas();
      }, (err) => console.warn('[bme295c] schedule onSnapshot error', err));
  } catch (e) {
    console.warn('[bme295c] attach schedule listener failed', e);
  }
}

/** V3.285 — flush every pending response autosave + capture in-flight
 * textarea values into the in-memory cache so the next render rehydrates
 * the textareas with the student's unsaved text (NOT the stale cached
 * text). Called before any code path that does `refreshCanvas()` while
 * a student may be mid-keystroke. Currently invoked from the schedule
 * onSnapshot handler; future call sites (tab switches, etc.) should
 * route through here too.
 */
function flushPendingResponseAutosaves() {
  if (!_bmeGroupResponses) return;
  Object.keys(_bmeResponseSaveTimers).forEach(slug => {
    const t = _bmeResponseSaveTimers[slug];
    if (!t) return;
    clearTimeout(t);
    _bmeResponseSaveTimers[slug] = null;
    // Read the live textarea values before refreshCanvas destroys them.
    const live = bmeReadPromptsFromDom(slug);
    // Rehydrate cache so the rebuild renders the in-flight text.
    const existing = _bmeGroupResponses.get(slug);
    if (existing) {
      existing.prompts = live;
      _bmeGroupResponses.set(slug, existing);
    } else {
      _bmeGroupResponses.set(slug, { prompts: live, status: 'draft' });
    }
    // Defer the actual Firestore write until after refreshCanvas
    // completes so the new statusEl + submit button are mounted (Fix 1
    // showDropReason needs them to surface any save failure visibly).
    setTimeout(() => saveBmeGroupResponsePrompts(slug, live, null, null), 50);
  });
}

function detachBmeScheduleListener() {
  if (_bmeScheduleUnsub) {
    try { _bmeScheduleUnsub(); } catch (e) {}
    _bmeScheduleUnsub = null;
  }
}

/** V3.286 — admin-side onSnapshot on schedules/bme295c/assessments so
 * the aggregated dashboard panels (counts / histograms / free-text /
 * per-speaker) update live as students submit. Twin of
 * attachBmeDashboardListener (V3.251). Idempotent; only attaches for
 * admin viewers since the rule only lets admin / classAdminEmails
 * read the full collection. Detached in cleanupListeners.
 */
function attachBmeAssessmentsListener() {
  if (_bmeAssessmentsUnsub) return;
  if (_viewType !== 'admin') return;
  try {
    _bmeAssessmentsUnsub = McgheeLab.db.collection('schedules').doc(_scheduleId)
      .collection('assessments').onSnapshot((snap) => {
        if (!_bmeDashboardData) return;
        if (!_bmeDashboardData.assessments) _bmeDashboardData.assessments = new Map();
        let changed = false;
        snap.docChanges().forEach(c => {
          const id = c.doc.id;
          if (c.type === 'removed') {
            _bmeDashboardData.assessments.delete(id);
            changed = true;
          } else {
            _bmeDashboardData.assessments.set(id, { id, ...c.doc.data() });
            changed = true;
          }
        });
        if (changed) {
          // Re-render the admin dashboard so the live counts + bars
          // update. Skip if the dashboard tab isn't active.
          const tab = getActiveTab();
          if (tab?.sections?.some(s => s.key === 'adminDash295c')) refreshCanvas();
        }
      }, (err) => console.warn('[bme295c] assessments onSnapshot error', err));
  } catch (e) {
    console.warn('[bme295c] attach assessments listener failed', e);
  }
}

function detachBmeAssessmentsListener() {
  if (_bmeAssessmentsUnsub) {
    try { _bmeAssessmentsUnsub(); } catch (e) {}
    _bmeAssessmentsUnsub = null;
  }
}

/* ================================================================
   PREVIEW TOGGLE
   ================================================================ */
function togglePreview() {
  if (_previewMode) {
    _previewMode = false;
    const btn = document.getElementById('cb-preview-btn');
    if (btn) btn.textContent = 'Preview';
  } else {
    gatherContentFromDOM();
    _previewMode = true;
    const btn = document.getElementById('cb-preview-btn');
    if (btn) btn.textContent = 'Edit';
  }
  refreshCanvas();
}

/* ================================================================
   CANVAS HTML
   ================================================================ */
function buildCanvasHTML() {
  const editing = isEditing();
  const tab = getActiveTab();

  let html = '';

  // V3.250 — test-mode banner (admin-only). Reminds the admin that
  // anything they do right now is tagged for wipe.
  if (_realIsAdmin && _classData?.testMode === true) {
    html += `<div class="cb295-testmode-banner" role="status">
      <span class="cb295-testmode-banner-icon" aria-hidden="true">${ICON.svg('exclamation-triangle')}</span>
      <span class="cb295-testmode-banner-text">
        <strong>Test mode is ON.</strong> Group responses you submit are tagged for cleanup.
        Exit and wipe before the class goes live — controls are on the Admin Dashboard tab.
      </span>
    </div>`;
  }

  // V3.248 — admin View-as toolbar (Admin / Student / Public). Visible
  // only for real admins; survives tab/section switches within the page.
  html += buildViewAsToolbar();

  // Preview banner
  if (_viewType === 'admin' && _previewMode) {
    html += '<div class="cb-preview-banner"><span>Viewing as public</span></div>';
  }

  // Tab bar
  html += buildTabBar();

  // Add Section dropdown (admin editing only)
  if (editing) {
    html += `<div class="cb-add-section-bar">
      <div class="cb-mobile-dropdown">
        <button type="button" class="btn btn-small" id="cb-add-section-btn">+ Section</button>
        <div class="cb-dropdown-menu" id="cb-section-dropdown">${buildSectionDropdownItems()}</div>
      </div>
    </div>`;
  }

  if (!tab) {
    html += '<p class="muted-text" style="text-align:center;padding:2rem;">No tabs yet. Click + to create one.</p>';
    return html;
  }

  // Canvas with sections
  html += `<div class="cb-canvas${editing ? '' : ' cb-canvas-readonly'}" id="cb-canvas">`;
  const sections = tab.sections || [];
  if (!sections.length) {
    html += editing
      ? '<div class="cb-empty-hint">Add sections to this tab using the button above.</div>'
      : '<p class="muted-text" style="text-align:center;padding:2rem;">No content yet.</p>';
  } else {
    sections.forEach(sec => {
      html += buildSectionBlockHTML(sec);
    });
  }
  html += '</div>';
  return html;
}

/* ─── Tab Bar ───────────────────────────────────────────────── */
/* V3.681 — three audience flags on a tab, checked here and mirrored by
   buildSectionBlockHTML so a section cannot leak through a hand-built tab:
     adminOnly   — the instructor view (edit chrome, roster, deletes)
     staffOnly   — instructor OR a courseStaffEmails TA
     studentOnly — any signed-in @arizona.edu account (staff included: they
                   see their own empty list, which beats a tab that vanishes
                   when you sign in as staff and reappears when you don't)
   In edit mode every tab shows, or an admin could not manage what they
   cannot see. */
function tabIsVisible(t) {
  if (isEditing()) return true;
  if (t.adminOnly && _viewType !== 'admin') return false;
  if (t.staffOnly && !(_viewType === 'admin' || _isCourseStaff)) return false;
  if (t.studentOnly && !bme466SignedInStudent()) return false;
  return true;
}
function buildTabBar() {
  const editing = isEditing();
  const visibleTabs = _tabs.filter(tabIsVisible);
  // If the currently active tab is admin-only and the viewer can't see
  // it (because of a view-as override), fall through to the first
  // visible tab without mutating _activeTabId so that switching back to
  // admin view still lands you on the dashboard.
  const effectiveActiveId = visibleTabs.some(t => t.id === _activeTabId)
    ? _activeTabId
    : (visibleTabs[0]?.id || _activeTabId);
  let html = '<div class="cb-tab-bar">';
  visibleTabs.forEach(tab => {
    const active = tab.id === effectiveActiveId;
    const adminTag = tab.adminOnly ? '<span class="cb-tab-admin-tag" title="Admin only">ADMIN</span>'
      : tab.staffOnly ? '<span class="cb-tab-admin-tag" title="Instructor + TAs only">STAFF</span>'
      : tab.studentOnly ? '<span class="cb-tab-admin-tag" title="Signed-in students only">MINE</span>' : '';
    html += `<div class="cb-tab${active ? ' cb-tab-active' : ''}${(tab.adminOnly || tab.staffOnly) ? ' cb-tab-admin' : ''}" data-tab-id="${tab.id}">
      <span class="cb-tab-name">${esc(tab.name)}</span>${adminTag}
      ${editing ? `<button type="button" class="cb-tab-delete" data-tab-id="${tab.id}" title="Delete tab">&times;</button>` : ''}
    </div>`;
  });
  if (editing) {
    html += '<button type="button" class="cb-tab-add" id="cb-add-tab" title="Add tab">+</button>';
  }
  html += '</div>';
  return html;
}

/* ─── View-as Toolbar (V3.248) ──────────────────────────────── */
/** Render the admin's "View as" strip at the top of the class page. Only
 * appears for real admins (global or class-admin). Provides three modes:
 * Admin (no override), Student (impersonate a roster entry), Public
 * (signed-out preview). Choice persists in module scope across tab
 * swaps but resets on full page navigation.
 */
function buildViewAsToolbar() {
  if (!_realIsAdmin) return '';
  const roster = Array.isArray(_classData?.studentRoster) ? _classData.studentRoster : [];
  const override = _adminViewOverride;
  const mode = override?.type || 'admin';
  const selectedStudentId = override?.type === 'student' ? override.studentId : '';
  const studentOpts = roster
    .filter(s => (s.email || '').trim())
    .slice()
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
    .map(s => {
      const label = `${(s.name || '').split(',')[0]} (${s.campus || '—'})`;
      return `<option value="${escAttr(s.id)}" ${s.id === selectedStudentId ? 'selected' : ''}>${esc(label)}</option>`;
    }).join('');
  /* V3.734 — a compact segmented toggle. "Student" no longer needs a
     roster: with nothing picked it is YOU as a plain signed-in student
     (admin + staff flags off), which is what "let me see what students
     see" means for a class without a roster (BME 466). Picking a roster
     entry still impersonates that student. */
  return `
    <div class="cb295-viewas" role="toolbar" aria-label="Admin view-as switcher">
      <span class="cb295-viewas-label">View as</span>
      <div class="cb295-viewas-seg">
        <button type="button" class="cb295-viewas-btn${mode === 'admin' ? ' cb295-viewas-btn-active' : ''}" data-viewas="admin">Admin</button>
        <button type="button" class="cb295-viewas-btn${mode === 'student' ? ' cb295-viewas-btn-active' : ''}" data-viewas="student">Student</button>
        <button type="button" class="cb295-viewas-btn${mode === 'public' ? ' cb295-viewas-btn-active' : ''}" data-viewas="public">Public</button>
      </div>
      ${mode === 'student' && studentOpts ? `
      <select class="cb295-viewas-student" id="cb295-viewas-student-select" aria-label="Which student">
        <option value="" ${selectedStudentId ? '' : 'selected'}>myself (a signed-in student)</option>
        ${studentOpts}
      </select>` : ''}
      ${mode !== 'admin'
        ? `<span class="cb295-viewas-note muted-text">Preview — your real role is ${_realIsClassAdminOnly ? 'class admin' : 'admin'}.</span>`
        : ''}
    </div>
  `;
}

/** Apply a new view-as mode and re-render. Triggers a fresh data load
 * so the impersonated roster entry's groupmates, daily-group context,
 * and content show up correctly.
 */
async function setAdminViewOverride(next) {
  _adminViewOverride = next;
  // Reload BME 295C data so _bmeRosterEntry / _bmeProfile / mates etc.
  // reflect the new viewer identity.
  if (_classData) {
    // Re-run the auth/role gate + data load by calling wireClassPage.
    // Don't await — the next refreshCanvas in setAdminViewOverride's
    // caller will pick up the new state once data resolves.
    await wireClassPage(_scheduleId);
  }
}

/* ─── Dropdown Builders ─────────────────────────────────────── */
function buildSectionDropdownItems() {
  return Object.entries(SECTION_REG).map(([key, reg]) => {
    return `<button type="button" class="cb-dropdown-item" data-add-type="section" data-add-key="${key}">${esc(reg.label)}</button>`;
  }).join('');
}

function buildWidgetDropdownItems() {
  return Object.entries(WIDGET_REG).map(([kind, reg]) => {
    return `<button type="button" class="cb-dropdown-item" data-add-type="widget" data-add-key="${kind}">${esc(reg.label)}</button>`;
  }).join('');
}

/* ================================================================
   SECTION BLOCK HTML
   ================================================================ */
function buildSectionBlockHTML(section) {
  const editing = isEditing();
  const reg = SECTION_REG[section.key];
  // V3.244 — admin-only sections render to nothing for non-admin viewers.
  if (section.key === 'roster295c' && _viewType !== 'admin') return '';
  if (section.key === 'adminDash295c' && _viewType !== 'admin') return '';
  if (section.key === 'hwDash466' && _viewType !== 'admin') return '';
  // V3.681 — mirror of tabIsVisible(), at the SECTION level: a section
  // dropped onto a hand-built public tab must not leak the staff surface.
  if (section.key === 'hwAssign466' && !(_viewType === 'admin' || _isCourseStaff)) return '';
  if (section.key === 'hwMine466' && !bme466SignedInStudent() && !editing) return '';
  const typeLabel = reg?.label || section.key;
  const displayName = section.name || typeLabel;
  const collapseIcon = ICON.svg(section.collapsed ? 'chevron-right' : 'chevron-down');

  if (!editing) {
    // Public / preview: read-only section + widgets
    let html = `<div class="cb-section cb-section-readonly cb-section-type-${esc(section.key)}" data-section-id="${section.id}">`;
    html += `<div class="cb-section-header-row">
      <button type="button" class="cb-section-collapse-toggle" data-section-id="${section.id}" title="Collapse/expand">${collapseIcon}</button>
      <h3 class="cb-section-title-readonly">${esc(displayName)}</h3>
    </div>`;
    html += `<div class="cb-section-collapsible${section.collapsed ? ' cb-collapsed' : ''}" data-section-id="${section.id}">`;
    html += `<div class="cb-section-body">${renderSectionBody(section)}</div>`;
    (section.widgets || []).forEach(w => {
      const wBody = renderWidgetBody(w);
      if (wBody) {
        if (w.kind === 'divider') { html += '<hr class="cb-divider" />'; }
        else { html += `<div class="cb-widget cb-widget-readonly"><div class="cb-widget-body">${wBody}</div></div>`; }
      }
    });
    html += '</div>'; // close collapsible
    html += '</div>'; // close section
    return html;
  }

  // Admin editing: section chrome + body + widgets + add-widget
  let html = `<div class="cb-section cb-section-type-${esc(section.key)}" data-section-id="${section.id}" data-section-key="${section.key}">`;
  // Chrome bar
  html += `<div class="cb-section-chrome">
    <span class="cb-section-handle" title="Drag to reorder">&#x2801;&#x2801;</span>
    <button type="button" class="cb-section-collapse-toggle" data-section-id="${section.id}" title="Collapse/expand">${collapseIcon}</button>
    <span class="cb-section-label" title="Double-click to rename">${esc(displayName)}</span>
    <span class="cb-block-type-badge">${esc(typeLabel)}</span>
    <div class="cb-block-actions">
      <button type="button" class="cb-section-move" data-dir="up" title="Move up">&uarr;</button>
      <button type="button" class="cb-section-move" data-dir="down" title="Move down">&darr;</button>
      <button type="button" class="cb-section-remove" title="Remove section">&times;</button>
    </div>
  </div>`;
  // Collapsible body
  html += `<div class="cb-section-collapsible${section.collapsed ? ' cb-collapsed' : ''}" data-section-id="${section.id}">`;
  // Section body
  html += `<div class="cb-section-body">${renderSectionBody(section)}</div>`;
  // Nested widgets (always render drop zone)
  html += `<div class="cb-widgets-area" data-section-id="${section.id}">`;
  (section.widgets || []).forEach(w => {
    html += buildWidgetBlockHTML(w, section.id);
  });
  html += '</div>';
  // Add widget dropdown
  html += `<div class="cb-add-widget-bar">
    <div class="cb-mobile-dropdown">
      <button type="button" class="btn btn-small btn-ghost cb-add-widget-trigger" data-section-id="${section.id}">+ Widget</button>
      <div class="cb-dropdown-menu cb-widget-dropdown-menu">${buildWidgetDropdownItems()}</div>
    </div>
  </div>`;
  html += '</div>'; // close collapsible
  html += '</div>'; // close section
  return html;
}

/* ================================================================
   WIDGET BLOCK HTML
   ================================================================ */
function buildWidgetBlockHTML(widget, sectionId) {
  const editing = isEditing();
  const label = WIDGET_REG[widget.kind]?.label || widget.kind;

  if (!editing) {
    if (widget.kind === 'divider') return '<hr class="cb-divider" />';
    const body = renderWidgetBody(widget);
    return body ? `<div class="cb-widget cb-widget-readonly"><div class="cb-widget-body">${body}</div></div>` : '';
  }

  return `<div class="cb-widget" data-widget-id="${widget.id}" data-widget-kind="${widget.kind}" data-parent-section="${sectionId}">
    <div class="cb-widget-chrome">
      <span class="cb-widget-handle" title="Drag to reorder">&#x2801;&#x2801;</span>
      <span class="cb-widget-label">${esc(label)}</span>
      <span class="cb-block-type-badge">Widget</span>
      <div class="cb-block-actions">
        <button type="button" class="cb-widget-move" data-dir="up" title="Move up">&uarr;</button>
        <button type="button" class="cb-widget-move" data-dir="down" title="Move down">&darr;</button>
        <button type="button" class="cb-widget-remove" title="Remove widget">&times;</button>
      </div>
    </div>
    <div class="cb-widget-body">${renderWidgetBody(widget)}</div>
  </div>`;
}

/* ================================================================
   SECTION BODY RENDERERS
   ================================================================ */
function renderSectionBody(section) {
  const reg = SECTION_REG[section.key];
  if (!reg) return '<p class="muted-text">Unknown section.</p>';
  const editing = isEditing();

  switch (reg.component) {
    case 'text': {
      const content = section.content || '';
      if (editing) {
        return `<textarea class="cb-textarea cb-section-text" data-section-id="${section.id}" rows="6" placeholder="Enter ${(section.name || reg.label).toLowerCase()} content...">${esc(content)}</textarea>
          <p class="muted-text" style="margin:4px 0 0;font-size:.75rem;">Plain text. URLs auto-link. Blank lines for paragraphs.</p>`;
      }
      return `<div class="text-preview">${renderText(content)}</div>`;
    }
    // V3.656 — same editing affordance as 'text', richer read-only render.
    case 'richtext': {
      const content = section.content || '';
      if (editing) {
        return `<textarea class="cb-textarea cb-section-text" data-section-id="${section.id}" rows="14" placeholder="Enter ${(section.name || reg.label).toLowerCase()} content...">${esc(content)}</textarea>
          <p class="muted-text" style="margin:4px 0 0;font-size:.75rem;">Markdown-lite: <code>## heading</code>, <code>**bold**</code>, <code>- bullet</code>, <code>1. numbered</code>, <code>|&nbsp;tables&nbsp;|</code> with a <code>|---|</code> row, <code>---</code> rule. URLs auto-link.</p>`;
      }
      return `<div class="text-preview cb-richtext">${renderRichText(content)}</div>`;
    }
    case 'files': {
      const files = _fileData[section.id] || [];
      const canUpload = editing || (_viewType === 'guest' && section.key === 'files');
      let html = '';
      if (canUpload) {
        html += `<div class="file-upload-area">
          <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:end;">
            <div class="form-group" style="flex:2;min-width:200px;">
              <label>Upload File</label>
              <input type="file" class="cb-file-input" data-section-id="${section.id}" />
            </div>
            <div class="form-group" style="flex:1;min-width:150px;">
              <label>Description</label>
              <input type="text" class="cb-file-desc" placeholder="Brief description" />
            </div>
            ${reg.hasDue ? '<div class="form-group" style="min-width:140px;"><label>Due</label><input type="date" class="cb-file-due" /></div>' : ''}
            <button type="button" class="btn cb-file-upload-btn" data-section-id="${section.id}">Upload</button>
          </div>
          <div class="cb-file-status save-status"></div>
        </div>`;
      }
      html += `<div class="cb-file-list" data-section-id="${section.id}">${buildFileListHTML(files, reg)}</div>`;
      return html;
    }
    case 'speakers':
      return `<div id="cb-speakers-${section.id}">${McgheeLab.Scheduler?.render?.(buildSchedulerConfig()) || '<p class="muted-text">Scheduler not loaded.</p>'}</div>`;
    // V3.716 — `section` is now passed: each modules section owns its own list.
    case 'modules':
      return renderModulesBody(editing, section);
    // V3.803 — derived lists by type (Homework & Keys, Reports & Tests).
    case 'typedModules':
      return renderTypedModulesBody(editing, section);
    // ── BME 295C (V3.244) class-specific section bodies ─────────
    case 'checkin295c':  return renderBmeCheckinBody(section);
    case 'syllabus295c': return renderBmeSyllabusBody();
    case 'schedule295c': return renderBmeScheduleBody();
    case 'modules295c':  return renderBmeModulesBody();
    case 'roster295c':   return renderBmeRosterBody(editing);
    case 'chat295c':     return renderBmeChatBody(editing);
    case 'assessment295c': return renderBmeAssessmentBody(editing);
    case 'adminDash295c': return renderBmeAdminDashBody(editing);
    case 'hwDash466':    return renderHw466DashBody();
    // V3.681 — BME466 course platform
    case 'hwList466':    return renderHw466ListBody();
    case 'hwMine466':    return renderHw466MineBody();
    case 'hwAssign466':  return renderHw466AssignBody();
    // V3.677 — live whiteboard board list. whiteboard.js owns the body,
    // hydration, and all board behavior; canEdit follows the View-as
    // override (so admin's "Student"/"Public" preview shows the real
    // student experience). The board page itself re-checks the gate.
    case 'whiteboard':
      return window.Whiteboard?.renderSectionBody?.(section, _scheduleId, {
        canEdit: _viewType === 'admin',
        liveWhiteboard: _classData?.liveWhiteboard || null
      }) ?? '<p class="muted-text">Whiteboard module not loaded.</p>';
    default:
      return '<p class="muted-text">Unknown component.</p>';
  }
}

/* V3.660 — a module entry may be a lesson (default) or instructor **notes**.
   Notes reuse the same modules[] array and the same manifest.json file list —
   only the presentation and the default visibility differ. `kind:'notes'` is
   additive, so every pre-existing entry keeps behaving exactly as before. */
function isNotesEntry(mod) { return mod?.kind === 'notes'; }

/* ─── Module types (V3.803) ─────────────────────────────────────
   Alex: "when i add a new learning module to the learning module stack, i want
   to set a type. Homework, Homework key, report, test, module, pretest.
   Homeworks and keys should automatically be added to the homework tab. Make
   another tab for reports and tests."

   `type` is one optional field on a modules[] entry. Absent = 'module', so
   nothing authored before V3.803 moves until it is retyped. Notes (kind:'notes')
   never carry a listing type — they always stay in the stack. */
const MODULE_TYPES = [
  ['module',       'Module'],
  ['pretest',      'Pretest'],
  ['homework',     'Homework'],
  ['homework_key', 'Homework key'],
  ['report',       'Report'],
  ['test',         'Test']
];
/* Which typedModules section LISTS each type on the public page. Types absent
   here (module, pretest) stay in their Learning Modules section. */
const MODULE_TYPE_HOME = {
  homework: 'homeworkModules', homework_key: 'homeworkModules',
  report:   'reportTestModules', test: 'reportTestModules'
};
/* Types that start HIDDEN when added. A key that is visible the moment it is
   added is the one mistake this field must not make easy. */
const MODULE_TYPE_HIDDEN_DEFAULT = ['homework_key', 'test'];
/* Short glyph for the 22/28px circle where a lesson number would go. */
const MODULE_TYPE_SHORT = { pretest: 'PRE', homework: 'HW', homework_key: 'KEY', report: 'RPT', test: 'TST' };

/* ─── Type guessing ───
   Alex: "any module i upload should have a type attached to it to autosort
   them upon load." This course's catalog carries the type in the file name
   and title (hw-01-…, HW1-student-key.html, report-01-…, hw-00-pretest.html),
   so a new entry is pre-typed from them in the picker, and an entry with no
   type at all reads as its guess everywhere (class page, viewer, module
   header) and is stamped at load by ensureModuleTypes(). Keyword-only, most
   specific first; anything unrecognised is a plain module, and the editor's
   Type select is the one-click correction. An explicit type — including
   'module' — is never second-guessed. */
function guessModuleType(htmlFile, title) {
  const s = `${htmlFile || ''} ${title || ''}`;
  const hwWord = /\b(?:hw|homework|assignment|problem[- ]?set)\b|\bhw-?\d/i;
  if (/\b(?:solutions?|answer[- ]?key)\b/i.test(s) || (/\bkey\b/i.test(s) && hwWord.test(s))) return 'homework_key';
  if (/pre-?test|diagnostic/i.test(s)) return 'pretest';
  if (hwWord.test(s)) return 'homework';
  if (/\breports?\b/i.test(s)) return 'report';
  if (/\b(?:test|exam|midterm|final|quiz)\b/i.test(s)) return 'test';
  return 'module';
}

function moduleType(mod) {
  const t = mod?.type;
  if (MODULE_TYPES.some(x => x[0] === t)) return t;
  return guessModuleType(mod?.htmlFile, mod?.title);
}
function moduleTypeLabel(type) { return (MODULE_TYPES.find(x => x[0] === type) || [, type])[1]; }
/** The typedModules section key that lists this entry, or null when it stays
    in its own Learning Modules section. Notes never leave the stack. */
function moduleHomeKey(mod) {
  if (isNotesEntry(mod)) return null;
  return MODULE_TYPE_HOME[moduleType(mod)] || null;
}
/** Visible-by-default rule for a new entry: notes, keys and tests start hidden. */
function defaultPublishedFor(kind, type) {
  if (kind === 'notes') return false;
  return !MODULE_TYPE_HIDDEN_DEFAULT.includes(type);
}

/* V3.803 — an editor notice in the site's own toast (same markup and CSS as
   app.js's .pwa-toast), for the places that used to alert(). */
function cbToast(html) {
  document.querySelector('.pwa-toast')?.remove();
  const t = document.createElement('div');
  t.className = 'pwa-toast';
  t.innerHTML = `<div class="pwa-toast-body">${html}</div>
    <div class="pwa-toast-actions"><button type="button" class="pwa-toast-close" aria-label="Dismiss">&times;</button></div>`;
  t.querySelector('.pwa-toast-close').addEventListener('click', () => t.remove());
  document.body.appendChild(t);
  setTimeout(() => { if (t.parentElement) t.remove(); }, 8000);
}

/* ─── Learning Modules placements (V3.716) ─────────────────────
   Every "Learning Modules" section is its own instance. Before this, the
   section body ignored its own `section` and read the one class-wide
   `_classData.modules` array, so a second modules section rendered a copy of
   the first and adding a module anywhere changed all of them.

   The array stays flat and class-wide — no schema move, no rules change — and
   is *partitioned* by `sectionId`. Every read filters, every write stamps. */

/** Every section of key 'modules', in tab order. */
function modulesSections() {
  const out = [];
  for (const tab of _tabs) {
    for (const sec of (tab.sections || [])) {
      if (sec.key === 'modules') out.push(sec);
    }
  }
  return out;
}

/* Migration + repair, run on load and on every canvas refresh. An entry with
   no `sectionId` (everything authored before V3.716) or one pointing at a
   section that has since been deleted is adopted by the FIRST modules section,
   so lessons can never silently disappear.

   Deliberately does NOT markDirty(): it mutates in memory and rides along on
   the next real save. That is the whole migration. It also bails when the class
   has no modules section at all, which is how teacher-classes (created with
   `tabs: []` and rendered by teacher-classes.js straight off `schedule.modules`)
   stay completely untouched. */
function ensureModulePlacements() {
  const secs = modulesSections();
  if (!secs.length) return;
  const valid = new Set(secs.map(s => s.id));
  const home = secs[0].id;
  (_classData?.modules || []).forEach(m => {
    if (!m.sectionId || !valid.has(m.sectionId)) m.sectionId = home;
  });
}

/** The modules belonging to one section, in display order. */
function modulesForSection(sectionId) {
  return (_classData?.modules || [])
    .filter(m => m.sectionId === sectionId)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

/* ─── Typed lists (V3.803) ──────────────────────────────────────
   A typedModules section is a DERIVED list: every entry in the class whose
   moduleHomeKey() is its key, in stack order (section tab order, then `order`).
   Nothing is copied, so there is nothing to drift. */
function modulesForTypedSection(key) {
  const rank = new Map(modulesSections().map((s, i) => [s.id, i]));
  return (_classData?.modules || [])
    .filter(m => moduleHomeKey(m) === key)
    .sort((a, b) => ((rank.get(a.sectionId) ?? 0) - (rank.get(b.sectionId) ?? 0))
                 || ((a.order ?? 0) - (b.order ?? 0)));
}

/* The "autosort upon load": an entry with no `type` is stamped with its guess,
   so the editor's Type select shows it and it persists on the next real save.
   In memory, never markDirty(); bails when the class has no modules section so
   teacher-classes stay untouched; notes are skipped (they never leave the stack). */
function ensureModuleTypes() {
  if (!modulesSections().length) return;
  (_classData?.modules || []).forEach(m => {
    if (isNotesEntry(m) || m.type) return;
    m.type = moduleType(m);
  });
}

/** The tab a Homework & Keys list belongs on: BME 466's Homeworks tab (the
    one holding hwList466), or any tab named like one. Null = make a new tab. */
function findHomeworkTab() {
  return _tabs.find(t => (t.sections || []).some(s => s.key === 'hwList466'))
      || _tabs.find(t => /homework/i.test(t.name || ''))
      || null;
}

/** Where a typedModules section currently lives: { tab, sec } or null. */
function typedListLocation(key) {
  for (const tab of _tabs) {
    const sec = (tab.sections || []).find(s => s.key === key);
    if (sec) return { tab, sec };
  }
  return null;
}

/* The "automatically" in the ask. In the mould of ensureModulePlacements():
   runs after it at load and on every canvas refresh, mutates _tabs in memory,
   never markDirty()s (it rides the next real save), and bails when the class has
   no modules section so teacher-classes (tabs: []) stay untouched.

   For each typed section key with at least one entry and no section yet:
   - Homework & Keys joins an existing Homeworks tab (BME 466: under the
     Assignments & Due Dates table) or gets a new public "Homeworks" tab.
   - Reports & Tests gets a new public tab after the Homeworks tab, else before
     the first gated (student / staff / admin) tab, else at the end.
   Returns what it created, in words, for the toast. Because it runs on every
   refresh, deleting the tab while typed entries exist brings it back — the way
   to remove it is to retype or delete the entries. */
function ensureTypedModuleTabs() {
  const created = [];
  if (!modulesSections().length) return created;
  for (const [key, reg] of Object.entries(SECTION_REG)) {
    if (reg.component !== 'typedModules') continue;
    if (!(_classData?.modules || []).some(m => moduleHomeKey(m) === key)) continue;
    if (typedListLocation(key)) continue;
    const sec = { key, id: genBlockId(), name: reg.label, collapsed: false, widgets: [], content: '' };
    const hwTab = findHomeworkTab();
    if (key === 'homeworkModules' && hwTab) {
      hwTab.sections = hwTab.sections || [];
      hwTab.sections.push(sec);
      created.push(`${reg.label} section on the ${hwTab.name} tab`);
      continue;
    }
    const tab = { id: genTabId(), name: reg.tabName || reg.label, sections: [sec] };
    const gated = _tabs.findIndex(t => t.adminOnly || t.staffOnly || t.studentOnly);
    const at = (key !== 'homeworkModules' && hwTab)
      ? _tabs.indexOf(hwTab) + 1
      : (gated === -1 ? _tabs.length : gated);
    _tabs.splice(at, 0, tab);
    created.push(`${tab.name} tab`);
  }
  return created;
}

/** The circle where a lesson number goes: number for a module, ✎ for notes,
    a short type glyph for everything else. `variant` is 'editor' or 'public'. */
function moduleNumBadge(mod, lessonNum, variant) {
  const isNotes = isNotesEntry(mod);
  const type = moduleType(mod);
  if (variant === 'public') {
    if (isNotes) return '<span style="display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:50%;background:rgba(217,119,6,.18);color:#f59e0b;font-size:.85rem;flex-shrink:0;">✎</span>';
    if (type === 'module') return `<span style="display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:50%;background:rgba(91,174,209,.15);color:#5baed1;font-size:.8rem;font-weight:600;flex-shrink:0;">${lessonNum}</span>`;
    return `<span class="cb-mod-type-circle cb-mod-type-circle-lg" data-type="${escAttr(type)}">${MODULE_TYPE_SHORT[type] || ''}</span>`;
  }
  if (isNotes) return '<span class="cb-mod-card-num cb-mod-card-num-notes">✎</span>';
  if (type === 'module') return `<span class="cb-mod-card-num">${lessonNum}</span>`;
  return `<span class="cb-mod-card-num cb-mod-type-circle" data-type="${escAttr(type)}">${MODULE_TYPE_SHORT[type] || ''}</span>`;
}
/** The pill after the title (HOMEWORK KEY, REPORT, …); empty for a plain module or notes. */
function moduleTypeTag(mod) {
  if (isNotesEntry(mod)) return '';
  const type = moduleType(mod);
  if (type === 'module') return '';
  const label = moduleTypeLabel(type);
  return `<span class="cb-mod-type-tag" data-type="${escAttr(type)}" title="${escAttr(label)}">${esc(label.toUpperCase())}</span>`;
}

/* ─── Typed list section body (V3.803) ───────────────────────── */
function renderTypedModulesBody(editing, section) {
  const reg = SECTION_REG[section?.key] || {};
  const all = modulesForTypedSection(section?.key);
  const typeNames = (reg.types || []).map(t => moduleTypeLabel(t)).join(' or ');
  const stackName = (mod) => findSectionById(mod.sectionId)?.name || 'its Learning Modules section';

  if (editing) {
    let html = '<div class="cb-modules-manager cb-typed-manager">';
    if (all.length) {
      all.forEach(mod => {
        html += `<div class="cb-mod-card cb-mod-card-listed" data-mod-id="${esc(mod.id)}">
          <div class="cb-mod-card-body">
            <div class="cb-mod-card-top">
              ${moduleNumBadge(mod, 0, 'editor')}
              <strong class="cb-mod-card-title">${esc(mod.title || 'Untitled')}</strong>
              ${moduleTypeTag(mod)}
              <span class="cb-mod-card-file muted-text">${esc(mod.folder ? mod.folder + '/' : '')}${esc(mod.htmlFile || '—')}</span>
              <label class="cb-mod-card-pub" title="Visible to students">
                <input type="checkbox" class="cb-mod-published" data-mod-id="${esc(mod.id)}" ${mod.published ? 'checked' : ''} /> Visible
              </label>
            </div>
            <div class="cb-mod-card-bottom">
              <span class="muted-text" style="font-size:.75rem;">From <strong>${esc(stackName(mod))}</strong> — reorder, retype or remove it there.</span>
            </div>
          </div>
        </div>`;
      });
    } else {
      html += '<p class="muted-text" style="margin:0 0 12px;">Nothing here yet.</p>';
    }
    html += `<p class="muted-text" style="margin:8px 0 0;font-size:.75rem;">Entries land here on their own when a module in any Learning Modules section has its <strong>Type</strong> set to ${esc(typeNames)}. This section stays while any such module exists.</p>`;
    html += '</div>';
    return html;
  }

  const published = all.filter(m => m.published);
  if (!published.length) return '<p class="muted-text">Nothing has been released here yet.</p>';
  let html = '<div class="cb-modules-list" style="display:flex;flex-direction:column;gap:6px;">';
  published.forEach(mod => {
    const href = `#/classes/${encodeURIComponent(_scheduleId)}/modules/${encodeURIComponent(mod.id)}`;
    html += `<a href="${href}" class="cb-module-link" style="display:flex;align-items:center;gap:12px;padding:10px 14px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:8px;text-decoration:none;color:var(--text,#eef2f7);transition:background .2s,border-color .2s;">
      ${moduleNumBadge(mod, 0, 'public')}
      <span style="font-weight:500;">${esc(mod.title || mod.htmlFile)}</span>
      ${moduleTypeTag(mod)}
    </a>`;
  });
  html += '</div>';
  return html;
}

/** Viewer progress text. "Lesson 3 of 7" counts only plain modules; the
    pretest and notes are named; a listed type reads "Homework key · 2 of 5". */
function moduleProgressLabel(current, siblings, currentIdx) {
  const type = moduleType(current);
  if (moduleHomeKey(current)) return `${moduleTypeLabel(type)} · ${currentIdx + 1} of ${siblings.length}`;
  if (isNotesEntry(current)) return 'Instructor notes';
  if (type === 'pretest') return 'Pretest';
  const isLesson = (m) => !isNotesEntry(m) && moduleType(m) === 'module';
  return `Lesson ${siblings.slice(0, currentIdx + 1).filter(isLesson).length} of ${siblings.filter(isLesson).length}`;
}

/* ─── Learning Modules Section Body ────────────────────────── */
function renderModulesBody(editing, section) {
  const modules = modulesForSection(section?.id);

  if (editing) {
    let html = '<div class="cb-modules-manager">';

    if (modules.length) {
      let lessonNum = 0;
      modules.forEach((mod, i) => {
        const hwLabel = getHomeworkLabel(mod.homeworkFileId);
        const isNotes = isNotesEntry(mod);
        /* V3.803 — the type drives the badge, the numbering and where the entry
           is listed. Only plain modules take a lesson number, so the editor's
           numbers match the public page. */
        const type = moduleType(mod);
        const home = moduleHomeKey(mod);
        if (!isNotes && type === 'module') lessonNum++;
        const where = home ? typedListLocation(home) : null;
        html += `<div class="cb-mod-card${isNotes ? ' cb-mod-card-notes' : ''}${home ? ' cb-mod-card-listed' : ''}" data-mod-id="${esc(mod.id)}">
          <div class="cb-mod-card-handle">
            <button type="button" class="btn btn-small btn-ghost cb-mod-move" data-dir="up" data-mod-id="${esc(mod.id)}" ${i === 0 ? 'disabled' : ''}>&uarr;</button>
            <button type="button" class="btn btn-small btn-ghost cb-mod-move" data-dir="down" data-mod-id="${esc(mod.id)}" ${i === modules.length - 1 ? 'disabled' : ''}>&darr;</button>
          </div>
          <div class="cb-mod-card-body">
            <div class="cb-mod-card-top">
              ${moduleNumBadge(mod, lessonNum, 'editor')}
              <strong class="cb-mod-card-title">${esc(mod.title || 'Untitled')}</strong>
              ${isNotes ? '<span class="cb-mod-notes-tag" title="Instructor notes — hidden from students unless you tick Visible">NOTES</span>' : moduleTypeTag(mod)}
              <span class="cb-mod-card-file muted-text">${esc(mod.folder ? mod.folder + '/' : '')}${esc(mod.htmlFile || '—')}</span>
              <label class="cb-mod-card-pub" title="${isNotes ? 'Notes are hidden from students by default' : 'Published'}">
                <input type="checkbox" class="cb-mod-published" data-mod-id="${esc(mod.id)}" ${mod.published ? 'checked' : ''} /> Visible
              </label>
            </div>
            <div class="cb-mod-card-bottom">
              ${isNotes
                ? '<span class="muted-text" style="font-size:.75rem;">Instructor notes — students never see this row while Visible is unticked.</span>'
                : `<label class="cb-mod-type-label muted-text">Type
                     <select class="cb-mod-type" data-mod-id="${esc(mod.id)}">${MODULE_TYPES.map(([v, l]) => `<option value="${v}"${v === type ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>
                   </label>
                   <button type="button" class="btn btn-small btn-ghost cb-mod-edit-hw" data-mod-id="${esc(mod.id)}">Homework: ${hwLabel ? esc(hwLabel) : '<em>None</em>'}</button>
                   ${home ? `<span class="muted-text cb-mod-listed-note">Listed on the <strong>${esc(where ? where.tab.name : (SECTION_REG[home].tabName || home))}</strong> tab, not here.</span>` : ''}`}
            </div>
          </div>
          <button type="button" class="btn btn-danger btn-small cb-mod-delete" data-mod-id="${esc(mod.id)}" title="Remove">&times;</button>
        </div>`;
      });
    } else {
      html += '<p class="muted-text" style="margin:0 0 12px;">No modules configured yet.</p>';
    }

    html += '<div class="cb-mod-add-row" style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;">';
    html += `<button type="button" class="btn btn-small cb-mod-add" data-section-id="${escAttr(section?.id || '')}">+ Add Module</button>`;
    html += `<button type="button" class="btn btn-small btn-ghost cb-mod-add-notes" data-section-id="${escAttr(section?.id || '')}" title="Add instructor notes — hidden from students by default">+ Add Notes</button>`;
    html += '</div>';
    html += `<p class="muted-text" style="margin:8px 0 0;font-size:.75rem;">Modules are visible to students as soon as you tick <strong>Visible</strong>; notes, keys and tests start hidden. Homework and keys are listed on the Homeworks tab, reports and tests on the Reports &amp; Tests tab — set the <strong>Type</strong> and the tab is made for you. Run <code>python3 scripts/scan_modules.py</code> after adding new HTML files.</p>`;
    html += '</div>';
    return html;
  }

  // Public view: clickable module list.
  // V3.803 — entries listed elsewhere by type (homework, keys, reports, tests)
  // are left out here; renderTypedModulesBody shows them on their own tab.
  const published = modules.filter(m => m.published && !moduleHomeKey(m));
  if (!published.length) return '<p class="muted-text">No modules available yet.</p>';

  let html = '<div class="cb-modules-list" style="display:flex;flex-direction:column;gap:6px;">';
  let lessonNum = 0;
  published.forEach((mod) => {
    const isNotes = isNotesEntry(mod);
    const type = moduleType(mod);
    if (!isNotes && type === 'module') lessonNum++;   // notes and the pretest don't consume a lesson number
    /* V3.716 — link by placement id, not filename. Two sections can hold the
       same lesson file (or two different folders' overview.html), and the old
       filename route resolved by first match, so both opened the same page with
       the wrong folder. wireModuleViewer still accepts a filename as a
       fallback, so pre-V3.716 links keep working. */
    const href = `#/classes/${encodeURIComponent(_scheduleId)}/modules/${encodeURIComponent(mod.id)}`;
    const badge = moduleNumBadge(mod, lessonNum, 'public');
    html += `<a href="${href}" class="cb-module-link" style="display:flex;align-items:center;gap:12px;padding:10px 14px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:8px;text-decoration:none;color:var(--text,#eef2f7);transition:background .2s,border-color .2s;">
      ${badge}
      <span style="font-weight:500;">${esc(mod.title || mod.htmlFile)}</span>
      ${isNotes ? '<span class="muted-text" style="font-size:.72rem;letter-spacing:.06em;">NOTES</span>' : moduleTypeTag(mod)}
    </a>`;
  });
  html += '</div>';
  return html;
}

/** Get a display label for a homework file ID */
function getHomeworkLabel(fileId) {
  if (!fileId) return null;
  for (const tab of _tabs) {
    for (const sec of (tab.sections || [])) {
      const reg = SECTION_REG[sec.key];
      if (reg?.component === 'files' && reg.hasDue) {
        const files = _fileData[sec.id] || [];
        const f = files.find(x => x.id === fileId);
        if (f) return f.fileName || f.description || fileId;
      }
    }
  }
  return fileId;
}

/** Fetch and cache the module manifest */
async function loadManifest() {
  if (_moduleManifest) return _moduleManifest;
  try {
    const resp = await fetch('modules/manifest.json?_=' + Date.now());
    if (resp.ok) _moduleManifest = await resp.json();
  } catch (e) {
    console.warn('[ClassBuilder] Could not load modules/manifest.json:', e);
  }
  return _moduleManifest || { folders: {} };
}

/** Build a flat list of all module files from the manifest for searching/browsing */
function flattenManifest(manifest) {
  const items = [];
  for (const [folder, data] of Object.entries(manifest.folders || {})) {
    for (const file of (data.files || [])) {
      items.push({ folder, folderLabel: data.label || folder, name: file.name, title: file.title });
    }
  }
  return items;
}

/** Build a flat list of all homework files from classFiles for searching/browsing */
function flattenHomeworkFiles() {
  const items = [];
  for (const tab of _tabs) {
    for (const sec of (tab.sections || [])) {
      const reg = SECTION_REG[sec.key];
      if (reg?.component === 'files' && reg.hasDue) {
        const files = _fileData[sec.id] || [];
        for (const f of files) {
          items.push({
            id: f.id,
            label: (sec.name || reg.label) + ': ' + (f.fileName || f.description || f.id),
            fileName: f.fileName || '',
            section: sec.name || reg.label
          });
        }
      }
    }
  }
  return items;
}

/* ─── FILE PICKER MODAL ────────────────────────────────────── */
/**
 * Open a generic file picker modal. Works for both module files and homework files.
 * @param {Object} opts
 * @param {string} opts.title       - Modal heading
 * @param {Array}  opts.items       - Array of pickable items
 * @param {Function} opts.renderItem  - (item) => { html, searchText }
 * @param {Function} opts.onSelect    - (item) => void
 * @param {string} [opts.groupKey]  - Optional property to group items by (e.g. 'folder')
 * @param {string} [opts.groupLabel] - Optional property for group display name
 */
function openFilePicker(opts) {
  let modal = document.getElementById('cb-filepicker-modal');
  if (modal) modal.remove();

  modal = document.createElement('div');
  modal.id = 'cb-filepicker-modal';
  modal.className = 'cb-modal-overlay';

  const items = opts.items || [];
  const grouped = {};
  if (opts.groupKey) {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const g = item[opts.groupKey] || 'Other';
      if (!grouped[g]) grouped[g] = { label: item[opts.groupLabel] || g, entries: [] };
      grouped[g].entries.push({ item, idx: i });
    }
  }

  let listHtml = '';
  if (opts.groupKey && Object.keys(grouped).length > 0) {
    for (const [gKey, gData] of Object.entries(grouped)) {
      listHtml += `<div class="cb-fp-group" data-group="${escAttr(gKey)}">
        <div class="cb-fp-group-label">${esc(gData.label)}</div>`;
      for (const entry of gData.entries) {
        const r = opts.renderItem(entry.item);
        listHtml += `<div class="cb-fp-item" data-fp-idx="${entry.idx}" data-search="${escAttr(r.searchText.toLowerCase())}">${r.html}</div>`;
      }
      listHtml += '</div>';
    }
  } else {
    for (let i = 0; i < items.length; i++) {
      const r = opts.renderItem(items[i]);
      listHtml += `<div class="cb-fp-item" data-fp-idx="${i}" data-search="${escAttr(r.searchText.toLowerCase())}">${r.html}</div>`;
    }
  }

  if (!items.length) {
    listHtml = '<p class="muted-text" style="padding:1rem;text-align:center;">No files found. Run <code>python3 scripts/scan_modules.py</code> to refresh.</p>';
  }

  modal.innerHTML = `
    <div class="cb-modal cb-fp-modal">
      <div class="cb-modal-header">
        <h3>${esc(opts.title || 'Select File')}</h3>
        <button type="button" class="cb-modal-close">&times;</button>
      </div>
      <div class="cb-fp-search-wrap">
        <input type="text" id="cb-fp-search" class="cb-fp-search" placeholder="Search files..." autofocus />
      </div>
      <div class="cb-fp-list" id="cb-fp-list">
        ${listHtml}
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  // Close handlers
  modal.querySelector('.cb-modal-close').addEventListener('click', () => modal.remove());
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

  // Search filtering
  const searchInput = modal.querySelector('#cb-fp-search');
  searchInput.addEventListener('input', () => {
    const q = searchInput.value.toLowerCase().trim();
    modal.querySelectorAll('.cb-fp-item').forEach(el => {
      const match = !q || el.dataset.search.includes(q);
      el.style.display = match ? '' : 'none';
    });
    // Hide empty groups
    modal.querySelectorAll('.cb-fp-group').forEach(g => {
      const visible = g.querySelectorAll('.cb-fp-item[style=""], .cb-fp-item:not([style])');
      // Check if any child items are visible
      let anyVisible = false;
      g.querySelectorAll('.cb-fp-item').forEach(item => {
        if (item.style.display !== 'none') anyVisible = true;
      });
      g.style.display = anyVisible ? '' : 'none';
    });
  });

  // Item click
  modal.querySelectorAll('.cb-fp-item').forEach(el => {
    el.addEventListener('click', () => {
      const idx = parseInt(el.dataset.fpIdx);
      if (!isNaN(idx)) { opts.onSelect(items[idx]); modal.remove(); }
    });
  });

  // Focus search
  setTimeout(() => searchInput.focus(), 50);
}

/* ─── ADD MODULE / NOTES MODAL ─────────────────────────────── */
/* V3.660 — `kind` is 'module' (default) or 'notes'. Same manifest, same picker;
   notes just land in the list flagged and, importantly, UNPUBLISHED.
   V3.716 — `sectionId` is the Learning Modules section the button was clicked
   in; the new entry is stamped with it so it lands in that section only. */
async function openAddModuleModal(kind, sectionId) {
  const isNotes = kind === 'notes';
  const manifest = await loadManifest();
  const allFiles = flattenManifest(manifest);

  let modal = document.getElementById('cb-addmod-modal');
  if (modal) modal.remove();

  modal = document.createElement('div');
  modal.id = 'cb-addmod-modal';
  modal.className = 'cb-modal-overlay';

  // Build folder-organized dropdown options
  let optionsHtml = '<option value="">— Select a file —</option>';
  for (const [folder, data] of Object.entries(manifest.folders || {})) {
    optionsHtml += `<optgroup label="${esc(data.label || folder)}">`;
    for (const file of (data.files || [])) {
      optionsHtml += `<option value="${escAttr(folder + '/' + file.name)}" data-title="${escAttr(file.title)}">${esc(file.name)}</option>`;
    }
    optionsHtml += '</optgroup>';
  }

  modal.innerHTML = `
    <div class="cb-modal cb-addmod-modal">
      <div class="cb-modal-header">
        <h3>${isNotes ? 'Add Instructor Notes' : 'Add Learning Module'}</h3>
        <button type="button" class="cb-modal-close">&times;</button>
      </div>
      <div class="cb-modal-body">
        ${isNotes ? `<p class="muted-text" style="margin:0 0 12px;font-size:.8rem;line-height:1.5;">
          Notes are added <strong>hidden from students</strong> — the Visible box stays unticked
          until you decide otherwise. Note that this hides the row, not the file: the page itself
          is still reachable by anyone who has its direct URL, so keep exam keys and grades out of it.
        </p>` : ''}
        <div class="form-group">
          <label>${isNotes ? 'Notes Title' : 'Lesson Title'}</label>
          <input type="text" id="cb-addmod-title" placeholder="${isNotes ? 'e.g. Week 1 — board notes' : 'e.g. Introduction to Microfluidics'}" />
        </div>
        <div class="form-group">
          <label>${isNotes ? 'Notes File' : 'Module File'}</label>
          <select id="cb-addmod-dropdown">${optionsHtml}</select>
        </div>
        ${isNotes ? '' : `<div class="form-group">
          <label>Type</label>
          <select id="cb-addmod-type">${MODULE_TYPES.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('')}</select>
          <p class="muted-text" style="margin:4px 0 0;font-size:.75rem;line-height:1.5;">Homework and keys are listed on the <strong>Homeworks</strong> tab, reports and tests on a <strong>Reports &amp; Tests</strong> tab — each made for you if the class has none. Keys and tests start hidden.</p>
        </div>`}
        <div class="form-group">
          <label style="margin-bottom:4px;">Or search all files</label>
          <input type="text" id="cb-addmod-search" placeholder="Type to search..." />
          <div class="cb-addmod-results" id="cb-addmod-results"></div>
        </div>
        <div class="cb-addmod-selected" id="cb-addmod-selected" style="display:none;">
          <span class="muted-text">Selected:</span> <strong id="cb-addmod-sel-label"></strong>
        </div>
        <div class="cb-addmod-error" id="cb-addmod-error" role="alert" style="display:none;"></div>
      </div>
      <div class="cb-modal-footer">
        <button type="button" class="btn btn-secondary cb-modal-close">Cancel</button>
        <button type="button" class="btn btn-primary" id="cb-addmod-confirm">${isNotes ? 'Add Notes' : 'Add Module'}</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  let selectedFile = null; // { folder, name, title }

  const titleInput = modal.querySelector('#cb-addmod-title');
  const dropdown = modal.querySelector('#cb-addmod-dropdown');
  const searchInput = modal.querySelector('#cb-addmod-search');
  const resultsDiv = modal.querySelector('#cb-addmod-results');
  const selectedDiv = modal.querySelector('#cb-addmod-selected');
  const selLabel = modal.querySelector('#cb-addmod-sel-label');

  /* V3.803 — the Type select follows the picked file (hw-01-… → Homework,
     …-key.html → Homework key, report-01-… → Report) until the user sets it. */
  const typeSel = modal.querySelector('#cb-addmod-type');
  let typeTouched = false;
  typeSel?.addEventListener('change', () => { typeTouched = true; });

  function selectFile(folder, name, title) {
    selectedFile = { folder, name, title };
    const errEl0 = modal.querySelector('#cb-addmod-error');
    if (errEl0) errEl0.style.display = 'none';
    if (typeSel && !typeTouched) typeSel.value = guessModuleType(name, title);
    selLabel.textContent = folder + '/' + name;
    selectedDiv.style.display = '';
    if (!titleInput.value.trim()) titleInput.value = title || '';
    // Reset search
    searchInput.value = '';
    resultsDiv.innerHTML = '';
  }

  // Dropdown change
  dropdown.addEventListener('change', () => {
    const val = dropdown.value;
    if (!val) return;
    const [folder, ...rest] = val.split('/');
    const name = rest.join('/');
    const opt = dropdown.selectedOptions[0];
    selectFile(folder, name, opt?.dataset.title || '');
  });

  // Search
  searchInput.addEventListener('input', () => {
    const q = searchInput.value.toLowerCase().trim();
    if (!q) { resultsDiv.innerHTML = ''; return; }
    const matches = allFiles.filter(f =>
      f.name.toLowerCase().includes(q) ||
      f.title.toLowerCase().includes(q) ||
      f.folder.toLowerCase().includes(q) ||
      f.folderLabel.toLowerCase().includes(q)
    ).slice(0, 20);

    if (!matches.length) {
      resultsDiv.innerHTML = '<div class="cb-addmod-noresult muted-text">No matches</div>';
      return;
    }

    resultsDiv.innerHTML = matches.map(f =>
      `<div class="cb-fp-item cb-addmod-result-item" data-folder="${escAttr(f.folder)}" data-name="${escAttr(f.name)}" data-title="${escAttr(f.title)}">
        <span class="cb-fp-item-folder">${esc(f.folderLabel)}</span>
        <span class="cb-fp-item-name">${esc(f.name)}</span>
        <span class="cb-fp-item-title muted-text">${esc(f.title)}</span>
      </div>`
    ).join('');

    resultsDiv.querySelectorAll('.cb-addmod-result-item').forEach(el => {
      el.addEventListener('click', () => selectFile(el.dataset.folder, el.dataset.name, el.dataset.title));
    });
  });

  // Close
  modal.querySelectorAll('.cb-modal-close').forEach(el => el.addEventListener('click', () => modal.remove()));
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

  // Confirm
  modal.querySelector('#cb-addmod-confirm').addEventListener('click', () => {
    if (!selectedFile) {
      /* V3.803 — inline, beside the field; never a browser popup */
      const errEl = modal.querySelector('#cb-addmod-error');
      errEl.textContent = isNotes ? 'Pick a notes file first.' : 'Pick a module file first.';
      errEl.style.display = '';
      modal.querySelector('#cb-addmod-search')?.focus();
      return;
    }
    const type = isNotes ? 'module' : (modal.querySelector('#cb-addmod-type')?.value || 'module');
    const title = titleInput.value.trim() || selectedFile.title || selectedFile.name;
    gatherContentFromDOM();
    if (!_classData.modules) _classData.modules = [];
    /* V3.716 — order is computed within the section, so each Learning Modules
       section numbers its own lessons from 1 instead of continuing a
       class-wide count. */
    const maxOrder = modulesForSection(sectionId).reduce((mx, m) => Math.max(mx, m.order ?? 0), -1);
    _classData.modules.push({
      id: (isNotes ? 'notes_' : 'mod_') + generateKey().slice(0, 8),
      sectionId: sectionId || null,
      title,
      htmlFile: selectedFile.name,
      folder: selectedFile.folder,
      order: maxOrder + 1,
      homeworkFileId: null,
      kind: isNotes ? 'notes' : 'module',
      /* V3.803 — where the entry is listed; absent on older entries = 'module' */
      type,
      /* notes, keys and tests default to hidden; everything else to visible */
      published: defaultPublishedFor(isNotes ? 'notes' : 'module', type)
    });
    markDirty();
    modal.remove();
    /* V3.803 — a homework / report type may need its tab: make it now, say so */
    const created = ensureTypedModuleTabs();
    refreshCanvas();
    if (created.length) cbToast(`Added the ${esc(created.join(' and the '))}. ${esc(moduleTypeLabel(type))} entries are listed there.`);
  });

  setTimeout(() => titleInput.focus(), 50);
}

/* ─── HOMEWORK PICKER MODAL ────────────────────────────────── */
function openHomeworkPicker(modId) {
  const hwFiles = flattenHomeworkFiles();
  const mod = (_classData.modules || []).find(m => m.id === modId);
  if (!mod) return;

  openFilePicker({
    title: 'Link Homework',
    items: hwFiles,
    groupKey: 'section',
    groupLabel: 'section',
    renderItem: (item) => ({
      html: `<span class="cb-fp-item-name">${esc(item.fileName)}</span>
             <span class="cb-fp-item-title muted-text">${esc(item.section)}</span>`,
      searchText: item.label + ' ' + item.fileName
    }),
    onSelect: (item) => {
      gatherContentFromDOM();
      mod.homeworkFileId = item.id;
      markDirty();
      refreshCanvas();
    }
  });
}

function buildFileListHTML(files, reg) {
  if (!files.length) return '<p class="muted-text">No files yet.</p>';
  const editing = isEditing();
  let html = '<div style="overflow-x:auto;"><table class="scheduler-table"><thead><tr>';
  html += '<th>Name</th><th>Description</th>';
  if (reg.hasDue) html += '<th>Due</th>';
  html += '<th>Size</th><th>Uploaded</th><th></th>';
  if (editing) html += '<th></th>';
  html += '</tr></thead><tbody>';
  files.forEach(f => {
    const date = f.createdAt?.toDate?.() ? f.createdAt.toDate().toLocaleDateString() : '-';
    html += `<tr>
      <td>${esc(f.fileName || 'File')}</td>
      <td class="muted-text">${esc(f.description || '')}</td>`;
    if (reg.hasDue) html += `<td>${esc(f.dueDate || '-')}</td>`;
    html += `<td class="muted-text">${fmtSize(f.fileSize || 0)}</td>
      <td class="muted-text">${esc(f.uploadedByName || '-')}<br><small>${date}</small></td>
      <td><a href="${esc(f.fileUrl)}" target="_blank" rel="noopener" class="btn btn-small">Download</a></td>`;
    if (editing) html += `<td><button class="btn btn-danger btn-small cb-file-delete" data-file-id="${f.id}" data-storage-path="${esc(f.storagePath || '')}">Delete</button></td>`;
    html += '</tr>';
  });
  html += '</tbody></table></div>';
  return html;
}

/* ================================================================
   WIDGET BODY RENDERERS
   ================================================================ */
function renderWidgetBody(widget) {
  const editing = isEditing();
  switch (widget.kind) {
    case 'text': {
      const content = widget.content || '';
      if (editing) {
        return `<textarea class="cb-textarea cb-widget-text" data-widget-id="${widget.id}" rows="4" placeholder="Enter text...">${esc(content)}</textarea>`;
      }
      return content ? `<div class="text-preview">${renderText(content)}</div>` : '';
    }
    case 'image': {
      const url = widget.url || '';
      const caption = widget.caption || '';
      let html = '';
      if (url) {
        html += `<div class="cb-image-preview"><img src="${esc(url)}" alt="${esc(caption)}" loading="lazy" style="max-width:100%;border-radius:8px;" /></div>`;
        if (caption && !editing) html += `<p class="muted-text" style="text-align:center;margin-top:6px;font-size:.85rem;">${esc(caption)}</p>`;
      }
      if (editing) {
        html += `<div class="cb-image-controls" style="margin-top:8px;">
          <input type="file" class="cb-image-input" data-widget-id="${widget.id}" accept="image/*" />
          <input type="text" class="cb-image-caption-input" data-widget-id="${widget.id}" placeholder="Caption (optional)" value="${esc(caption)}" style="margin-top:4px;width:100%;" />
          <div class="cb-image-status save-status"></div>
        </div>`;
      }
      return html || (editing ? '<p class="muted-text">Upload an image above.</p>' : '');
    }
    case 'video': {
      const url = widget.url || '';
      const caption = widget.caption || '';
      let html = '';
      if (url) {
        const embedUrl = getVideoEmbedUrl(url);
        if (embedUrl) {
          html += `<div style="position:relative;padding-bottom:56.25%;height:0;overflow:hidden;border-radius:8px;">
            <iframe src="${esc(embedUrl)}" style="position:absolute;top:0;left:0;width:100%;height:100%;" frameborder="0" allow="accelerometer;autoplay;clipboard-write;encrypted-media;gyroscope;picture-in-picture" allowfullscreen></iframe>
          </div>`;
        } else {
          html += `<video src="${esc(url)}" controls style="max-width:100%;border-radius:8px;"></video>`;
        }
        if (caption && !editing) html += `<p class="muted-text" style="text-align:center;margin-top:6px;font-size:.85rem;">${esc(caption)}</p>`;
      }
      if (editing) {
        html += `<div style="margin-top:8px;">
          <input type="url" class="cb-video-url" data-widget-id="${widget.id}" placeholder="YouTube, Vimeo, or direct video URL" value="${esc(url)}" style="width:100%;" />
          <input type="text" class="cb-video-caption" data-widget-id="${widget.id}" placeholder="Caption (optional)" value="${esc(caption)}" style="margin-top:4px;width:100%;" />
        </div>`;
      }
      return html || '';
    }
    case 'links': {
      const items = widget.items || [];
      if (editing) {
        let html = `<div class="cb-links-editor" data-widget-id="${widget.id}">`;
        items.forEach((item, i) => {
          html += `<div class="cb-link-row" data-index="${i}" style="display:flex;gap:6px;margin-bottom:6px;">
            <input type="text" class="cb-link-label" placeholder="Label" value="${esc(item.label || '')}" style="flex:1;" />
            <input type="url" class="cb-link-url" placeholder="https://..." value="${esc(item.url || '')}" style="flex:2;" />
            <button type="button" class="btn btn-danger btn-small cb-link-remove">&times;</button>
          </div>`;
        });
        html += `<button type="button" class="btn btn-small cb-link-add" data-widget-id="${widget.id}">+ Add Link</button></div>`;
        return html;
      }
      if (!items.length) return '';
      return '<ul class="cb-link-list">' + items.filter(it => it.url).map(it =>
        `<li><a href="${esc(it.url)}" target="_blank" rel="noopener">${esc(it.label || it.url)}</a></li>`
      ).join('') + '</ul>';
    }
    case 'embed': {
      const raw = widget.html || '';
      if (editing) {
        return `<textarea class="cb-textarea cb-embed-editor" data-widget-id="${widget.id}" rows="4" placeholder="Paste HTML or iframe embed code...">${esc(raw)}</textarea>
          ${raw ? '<div class="cb-embed-preview" style="margin-top:8px;border:1px solid rgba(255,255,255,.1);border-radius:8px;overflow:hidden;">' + raw + '</div>' : ''}`;
      }
      return raw ? `<div class="cb-embed-preview">${raw}</div>` : '';
    }
    case 'simulation': {
      const code = widget.code || '';
      const title = widget.title || '';
      const lang = widget.lang || 'html';
      const srcdocFn = lang === 'python' ? buildPythonSrcdoc : buildSimSrcdoc;
      if (editing) {
        let html = `<input type="text" class="cb-sim-title" data-widget-id="${widget.id}" placeholder="Simulation title (optional)" value="${esc(title)}" style="width:100%;margin-bottom:8px;" />`;
        html += `<div style="margin-bottom:8px;">
          <label class="muted-text" style="font-size:.75rem;margin-right:6px;">Language:</label>
          <select class="cb-sim-lang" data-widget-id="${widget.id}" style="font-size:.82rem;padding:3px 6px;border-radius:4px;background:rgba(255,255,255,.08);color:var(--text,#eef2f7);border:1px solid rgba(255,255,255,.12);">
            <option value="html"${lang === 'html' ? ' selected' : ''}>HTML / JavaScript</option>
            <option value="python"${lang === 'python' ? ' selected' : ''}>Python (Pyodide)</option>
          </select>
        </div>`;
        const placeholder = lang === 'python'
          ? 'Write Python code here...\n\nprint(), matplotlib, numpy, and scipy are supported.\nUse SimExport.log(label, value) to let students export data.'
          : 'Paste HTML + JavaScript simulation code here...\n\nTip: Use SimExport.log(label, value) inside your code to let students export data.';
        html += `<textarea class="cb-textarea cb-sim-code" data-widget-id="${widget.id}" rows="12" placeholder="${escAttr(placeholder)}">${esc(code)}</textarea>`;
        html += `<p class="muted-text" style="margin:4px 0 0;font-size:.75rem;">${lang === 'python' ? 'Python code. Runs via Pyodide (WebAssembly CPython) in a sandboxed iframe.' : 'HTML + JS simulation code. Runs in a sandboxed iframe. Students can edit a local copy.'}</p>`;
        if (code) {
          html += `<div class="cb-sim-admin-preview" style="margin-top:12px;">
            <p class="muted-text" style="font-size:.75rem;margin-bottom:4px;">Preview:</p>
            <div class="cb-sim-container" data-widget-id="${widget.id}">
              <iframe class="cb-sim-iframe" data-widget-id="${widget.id}" sandbox="allow-scripts" srcdoc="${escAttr(srcdocFn(code, widget.id))}" style="width:100%;height:400px;border:1px solid rgba(255,255,255,.15);border-radius:8px;background:#fff;"></iframe>
            </div>
          </div>`;
        }
        return html;
      }
      // Public / student view
      if (!code) return '';
      let html = '';
      if (title) html += `<h4 class="cb-sim-view-title">${esc(title)}</h4>`;
      html += `<div class="cb-sim-container" data-widget-id="${widget.id}" data-lang="${lang}">
        <div class="cb-sim-toolbar">
          <button type="button" class="btn btn-small cb-sim-toggle-code" data-widget-id="${widget.id}" title="Edit code locally">Edit Code</button>
          <button type="button" class="btn btn-small cb-sim-run" data-widget-id="${widget.id}" title="Re-run simulation">Run</button>
          <button type="button" class="btn btn-small cb-sim-reset" data-widget-id="${widget.id}" title="Reset to original code">Reset</button>
          <button type="button" class="btn btn-small cb-sim-export" data-widget-id="${widget.id}" title="Export simulation data as CSV">Export Data</button>
          <button type="button" class="btn btn-small cb-sim-fullscreen" data-widget-id="${widget.id}" title="Fullscreen">&#x26F6; Fullscreen</button>
        </div>
        <div class="cb-sim-code-panel" data-widget-id="${widget.id}" style="display:none;">
          <textarea class="cb-textarea cb-sim-student-code" data-widget-id="${widget.id}" rows="10">${esc(code)}</textarea>
        </div>
        <iframe class="cb-sim-iframe" data-widget-id="${widget.id}" sandbox="allow-scripts" srcdoc="${escAttr(srcdocFn(code, widget.id))}" style="width:100%;height:500px;border:1px solid rgba(255,255,255,.15);border-radius:8px;background:#fff;"></iframe>
      </div>`;
      return html;
    }
    case 'divider':
      return '<hr class="cb-divider" />';
    default:
      return '<p class="muted-text">Unknown widget.</p>';
  }
}

function getVideoEmbedUrl(url) {
  if (!url) return null;
  let m = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  if (m) return 'https://www.youtube.com/embed/' + m[1];
  m = url.match(/vimeo\.com\/(\d+)/);
  if (m) return 'https://player.vimeo.com/video/' + m[1];
  return null;
}

/* ─── Simulation helpers ────────────────────────────────────── */

/** Wrap user simulation code with the SimExport bridge preamble */
function buildSimSrcdoc(code, widgetId) {
  const wid = widgetId || '';
  const preamble = `<script>
window.SimExport = {
  _data: [],
  log: function(label, value) {
    this._data.push({ label: String(label), value: value, t: Date.now() });
  },
  _flush: function() {
    parent.postMessage({ type: 'sim-export', widgetId: '${wid}', data: JSON.parse(JSON.stringify(this._data)) }, '*');
  }
};
window.addEventListener('message', function(e) {
  if (e.data && e.data.type === 'sim-flush') SimExport._flush();
});
<\/script>`;
  // If the code contains <head>, inject preamble after <head>
  if (/<head[^>]*>/i.test(code)) {
    return code.replace(/<head[^>]*>/i, '$&' + preamble);
  }
  // Otherwise prepend
  return preamble + code;
}

/** Build srcdoc for Python code using Pyodide (WebAssembly CPython) */
function buildPythonSrcdoc(code, widgetId) {
  const wid = widgetId || '';
  // Encode the Python code as base64 to avoid any escaping issues
  const codeB64 = btoa(unescape(encodeURIComponent(code)));
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family: 'SF Mono','Fira Code','Consolas',monospace; font-size:14px; background:#1e1e2e; color:#cdd6f4; padding:12px; }
  #status { color:#a6adc8; margin-bottom:8px; }
  #output { white-space:pre-wrap; word-wrap:break-word; line-height:1.5; }
  .err { color:#f38ba8; }
  .plot-img { max-width:100%; border-radius:6px; margin:8px 0; background:#fff; }
</style>
</head><body>
<div id="status">Loading Python runtime...</div>
<div id="output"></div>
<script>
window.SimExport = {
  _data: [],
  log: function(label, value) {
    this._data.push({ label: String(label), value: value, t: Date.now() });
  },
  _flush: function() {
    parent.postMessage({ type: 'sim-export', widgetId: '${wid}', data: JSON.parse(JSON.stringify(this._data)) }, '*');
  }
};
window.addEventListener('message', function(e) {
  if (e.data && e.data.type === 'sim-flush') SimExport._flush();
});

var _out = document.getElementById('output');
var _status = document.getElementById('status');

function appendOutput(text, cls) {
  var span = document.createElement('span');
  if (cls) span.className = cls;
  span.textContent = text;
  _out.appendChild(span);
}

async function runPython() {
  _out.innerHTML = '';
  _status.textContent = 'Loading Pyodide...';
  try {
    if (!window.loadPyodide) {
      var s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/pyodide/v0.27.5/full/pyodide.js';
      document.head.appendChild(s);
      await new Promise(function(r,j){ s.onload=r; s.onerror=function(){j(new Error('Failed to load Pyodide'))}; });
    }
    _status.textContent = 'Initializing Python...';
    var pyodide = await loadPyodide();
    _status.textContent = 'Installing packages...';
    await pyodide.loadPackage(['micropip']);
    // Pre-load common scientific packages
    var code = atob('${codeB64}');
    var needsNumpy = /\\b(numpy|np)\\b/.test(code);
    var needsMatplotlib = /\\b(matplotlib|plt)\\b/.test(code);
    var needsScipy = /\\bscipy\\b/.test(code);
    var pkgs = [];
    if (needsNumpy) pkgs.push('numpy');
    if (needsMatplotlib) pkgs.push('matplotlib');
    if (needsScipy) pkgs.push('scipy');
    if (pkgs.length) {
      _status.textContent = 'Installing ' + pkgs.join(', ') + '...';
      await pyodide.loadPackage(pkgs);
    }
    // Redirect stdout/stderr
    pyodide.runPython(\`
import sys, io
class _Out:
    def __init__(self, is_err=False):
        self.is_err = is_err
    def write(self, text):
        if text:
            from js import appendOutput
            appendOutput(text, 'err' if self.is_err else '')
    def flush(self): pass
sys.stdout = _Out()
sys.stderr = _Out(True)
\`);
    // Provide SimExport bridge to Python
    pyodide.runPython(\`
from js import window
class SimExport:
    @staticmethod
    def log(label, value):
        window.SimExport.log(str(label), float(value) if isinstance(value,(int,float)) else str(value))
\`);
    // If matplotlib is loaded, set up non-interactive backend + auto-show
    if (needsMatplotlib) {
      pyodide.runPython(\`
import matplotlib
matplotlib.use('AGG')
import matplotlib.pyplot as plt
_orig_show = plt.show
def _patched_show(*a, **kw):
    import io, base64
    from js import document
    for fig_num in plt.get_fignums():
        fig = plt.figure(fig_num)
        buf = io.BytesIO()
        fig.savefig(buf, format='png', dpi=100, bbox_inches='tight', facecolor='white')
        buf.seek(0)
        b64 = base64.b64encode(buf.read()).decode()
        img = document.createElement('img')
        img.src = 'data:image/png;base64,' + b64
        img.className = 'plot-img'
        document.getElementById('output').appendChild(img)
    plt.close('all')
plt.show = _patched_show
\`);
    }
    _status.textContent = 'Running...';
    await pyodide.runPythonAsync(code);
    // Auto-show any remaining matplotlib figures
    if (needsMatplotlib) {
      await pyodide.runPythonAsync(\`
import matplotlib.pyplot as plt
if plt.get_fignums():
    plt.show()
\`);
    }
    _status.textContent = 'Done.';
    setTimeout(function(){ _status.style.display='none'; }, 1500);
  } catch(err) {
    _status.textContent = 'Error';
    appendOutput(err.message || String(err), 'err');
  }
}
runPython();
<\/script>
</body></html>`;
}

/** Store per-widget export data from simulations */
const _simExportData = {};

/* ================================================================
   CANVAS WIRING
   ================================================================ */
function wireCanvas() {
  wireTabBar();
  wireViewAsToolbar();
  if (isEditing()) {
    wireSectionActions();
    wireWidgetActions();
    wireBlockEditors();
    wireAddDropdowns();
    initDragAndDrop();
  }
  // Wire collapse toggles and section rename (always, for both admin and readonly)
  wireSectionCollapse();
  if (isEditing()) wireSectionRename();
  // Wire speakers sections if present in active tab
  const tab = getActiveTab();
  (tab?.sections || []).filter(s => s.key === 'speakers').forEach(sec => {
    try { McgheeLab.Scheduler?.wire?.('cb-speakers-' + sec.id, buildSchedulerConfig()); } catch (e) { console.warn('Scheduler wire error:', e); }
  });
  // Wire BME 295C class-specific section handlers (V3.244)
  if (tab?.sections?.some(s => s.key === 'checkin295c')) wireBme295cCheckin();
  if (tab?.sections?.some(s => s.key === 'modules295c')) wireBme295cModules();
  if (tab?.sections?.some(s => s.key === 'roster295c')) wireBme295cRoster();
  if (tab?.sections?.some(s => s.key === 'chat295c')) wireBme295cChat();
  if (tab?.sections?.some(s => s.key === 'assessment295c')) wireBme295cAssessment();
  if (tab?.sections?.some(s => s.key === 'adminDash295c')) wireBme295cAdminDash();
  if (tab?.sections?.some(s => s.key === 'hwDash466')) wireHw466Dash();
  // V3.681 — BME466 course platform
  if (tab?.sections?.some(s => s.key === 'hwList466')) wireHw466List();
  if (tab?.sections?.some(s => s.key === 'hwMine466')) wireHw466Mine();
  if (tab?.sections?.some(s => s.key === 'hwAssign466')) wireHw466Assign();
  // Wire simulation widgets (works in both admin preview and public view)
  wireSimulations();
}

/* ─── View-as Toolbar wiring (V3.248) ──────────────────────── */
function wireViewAsToolbar() {
  document.querySelectorAll('.cb295-viewas-btn[data-viewas]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const mode = btn.dataset.viewas;
      if (mode === 'admin') {
        await setAdminViewOverride(null);
      } else if (mode === 'public') {
        await setAdminViewOverride({ type: 'public' });
      } else if (mode === 'student') {
        /* V3.734 — no roster needed: an empty studentId means "me, as a
           plain student" (no alert; browser popups are banned here) */
        const sel = document.getElementById('cb295-viewas-student-select');
        await setAdminViewOverride({ type: 'student', studentId: sel?.value || null });
      }
    });
  });
  document.getElementById('cb295-viewas-student-select')?.addEventListener('change', async (ev) => {
    await setAdminViewOverride({ type: 'student', studentId: ev.target.value || null });
  });
}

/* ─── Tab Bar Wiring ─────────────────────────────────────────── */
function wireTabBar() {
  // Tab switching
  document.querySelectorAll('.cb-tab[data-tab-id]').forEach(tabEl => {
    tabEl.addEventListener('click', (e) => {
      if (e.target.classList.contains('cb-tab-delete')) return;
      switchTab(tabEl.dataset.tabId);
    });
  });

  if (isEditing()) {
    // Tab rename (double-click)
    document.querySelectorAll('.cb-tab-name').forEach(span => {
      span.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        const tabId = span.closest('.cb-tab')?.dataset.tabId;
        renameTab(tabId);
      });
    });

    // Tab delete
    document.querySelectorAll('.cb-tab-delete').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteTab(btn.dataset.tabId);
      });
    });

    // Tab add
    document.getElementById('cb-add-tab')?.addEventListener('click', () => addTab());
  }
}

/* ─── Section Actions ────────────────────────────────────────── */
function wireSectionActions() {
  document.querySelectorAll('.cb-section-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      const secId = btn.closest('.cb-section')?.dataset.sectionId;
      if (secId && confirm('Remove this section and its widgets?')) removeSection(secId);
    });
  });
  document.querySelectorAll('.cb-section-move').forEach(btn => {
    btn.addEventListener('click', () => {
      const secId = btn.closest('.cb-section')?.dataset.sectionId;
      if (secId) moveSection(secId, btn.dataset.dir === 'up' ? -1 : 1);
    });
  });
}

/* ─── Section Collapse ───────────────────────────────────────── */
function wireSectionCollapse() {
  document.querySelectorAll('.cb-section-collapse-toggle').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const sectionId = btn.dataset.sectionId;
      const sec = findSectionById(sectionId);
      if (!sec) return;
      sec.collapsed = !sec.collapsed;
      // Find collapsible wrapper within the same parent section element
      const sectionEl = btn.closest('.cb-section');
      const collapsible = sectionEl?.querySelector('.cb-section-collapsible');
      if (collapsible) collapsible.classList.toggle('cb-collapsed', sec.collapsed);
      btn.innerHTML = ICON.svg(sec.collapsed ? 'chevron-right' : 'chevron-down');
      if (isEditing()) markDirty();
    });
  });
}

/* ─── Section Rename ─────────────────────────────────────────── */
function wireSectionRename() {
  document.querySelectorAll('.cb-section-label').forEach(span => {
    span.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      const secId = span.closest('.cb-section')?.dataset.sectionId;
      if (secId) renameSection(secId);
    });
  });
}

function renameSection(sectionId) {
  const sec = findSectionById(sectionId);
  if (!sec) return;
  const newName = prompt('Section name:', sec.name);
  if (newName && newName.trim() && newName.trim() !== sec.name) {
    sec.name = newName.trim();
    markDirty();
    refreshCanvas();
  }
}

/* ─── Widget Actions ─────────────────────────────────────────── */
function wireWidgetActions() {
  document.querySelectorAll('.cb-widget-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      const wEl = btn.closest('.cb-widget');
      const widgetId = wEl?.dataset.widgetId;
      if (widgetId && confirm('Remove this widget?')) removeWidget(widgetId);
    });
  });
  document.querySelectorAll('.cb-widget-move').forEach(btn => {
    btn.addEventListener('click', () => {
      const wEl = btn.closest('.cb-widget');
      const widgetId = wEl?.dataset.widgetId;
      if (widgetId) moveWidget(widgetId, btn.dataset.dir === 'up' ? -1 : 1);
    });
  });
}

/* ─── Block Editors ──────────────────────────────────────────── */
function wireBlockEditors() {
  // Mark dirty on any editor input
  document.querySelectorAll('.cb-textarea, .cb-widget-text, .cb-video-url, .cb-video-caption, .cb-image-caption-input, .cb-embed-editor, .cb-sim-code, .cb-sim-title, .cb-link-label, .cb-link-url').forEach(el => {
    el.addEventListener('input', () => markDirty());
  });
  // Language selector — gather + refresh so placeholder and preview update
  document.querySelectorAll('.cb-sim-lang').forEach(sel => {
    sel.addEventListener('change', () => { gatherContentFromDOM(); markDirty(); refreshCanvas(); });
  });

  // Link add
  document.querySelectorAll('.cb-link-add').forEach(btn => {
    btn.addEventListener('click', () => {
      const widget = findWidgetById(btn.dataset.widgetId);
      if (!widget) return;
      if (!widget.items) widget.items = [];
      gatherContentFromDOM();
      widget.items.push({ label: '', url: '' });
      markDirty();
      refreshCanvas();
    });
  });

  // Link remove
  document.querySelectorAll('.cb-link-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      const editor = btn.closest('.cb-links-editor');
      const row = btn.closest('.cb-link-row');
      const widget = findWidgetById(editor?.dataset.widgetId);
      const idx = parseInt(row?.dataset.index);
      if (widget?.items && !isNaN(idx)) {
        gatherContentFromDOM();
        widget.items.splice(idx, 1);
        markDirty();
        refreshCanvas();
      }
    });
  });

  // File upload
  document.querySelectorAll('.cb-file-upload-btn').forEach(btn => {
    btn.addEventListener('click', () => handleFileUpload(btn));
  });

  // File delete
  document.querySelectorAll('.cb-file-delete').forEach(btn => {
    btn.addEventListener('click', () => handleFileDelete(btn));
  });

  // Image upload
  document.querySelectorAll('.cb-image-input').forEach(input => {
    input.addEventListener('change', () => handleImageUpload(input));
  });

  // Module editors
  wireModuleEditors();
}

/* ─── Module Editor Wiring ────────────────────────────────────── */
function wireModuleEditors() {
  // Published checkbox
  document.querySelectorAll('.cb-mod-published').forEach(el => {
    el.addEventListener('change', () => markDirty());
  });

  // Add module — open modal. V3.716: scoped to the clicked section.
  document.querySelectorAll('.cb-mod-add').forEach(btn => {
    btn.addEventListener('click', () => openAddModuleModal('module', btn.dataset.sectionId));
  });

  // Add instructor notes — same picker, lands unpublished (V3.660)
  document.querySelectorAll('.cb-mod-add-notes').forEach(btn => {
    btn.addEventListener('click', () => openAddModuleModal('notes', btn.dataset.sectionId));
  });

  // Edit homework — open picker
  document.querySelectorAll('.cb-mod-edit-hw').forEach(btn => {
    btn.addEventListener('click', () => openHomeworkPicker(btn.dataset.modId));
  });

  // V3.803 — retype in place; a homework / report type may need its tab.
  document.querySelectorAll('.cb-mod-type').forEach(sel => {
    sel.addEventListener('change', () => {
      const mod = (_classData.modules || []).find(m => m.id === sel.dataset.modId);
      if (!mod) return;
      gatherContentFromDOM();
      mod.type = sel.value;
      markDirty();
      const created = ensureTypedModuleTabs();
      refreshCanvas();
      if (created.length) cbToast(`Added the ${esc(created.join(' and the '))}. ${esc(moduleTypeLabel(mod.type))} entries are listed there.`);
    });
  });

  // Delete module
  document.querySelectorAll('.cb-mod-delete').forEach(btn => {
    btn.addEventListener('click', () => {
      const modId = btn.dataset.modId;
      if (!confirm('Remove this module?')) return;
      gatherContentFromDOM();
      _classData.modules = (_classData.modules || []).filter(m => m.id !== modId);
      markDirty();
      refreshCanvas();
    });
  });

  // Move module up/down
  document.querySelectorAll('.cb-mod-move').forEach(btn => {
    btn.addEventListener('click', () => {
      const modId = btn.dataset.modId;
      const dir = btn.dataset.dir;
      gatherContentFromDOM();
      /* V3.716 — swap within the moved entry's own section. The old code sorted
         the whole class-wide array, so a move at a section boundary swapped
         order values with a lesson in a different section. */
      const moved = (_classData.modules || []).find(m => m.id === modId);
      if (!moved) return;
      const modules = modulesForSection(moved.sectionId);
      const idx = modules.findIndex(m => m.id === modId);
      if (idx < 0) return;
      const swapIdx = dir === 'up' ? idx - 1 : idx + 1;
      if (swapIdx < 0 || swapIdx >= modules.length) return;
      const tmpOrder = modules[idx].order;
      modules[idx].order = modules[swapIdx].order;
      modules[swapIdx].order = tmpOrder;
      markDirty();
      refreshCanvas();
    });
  });

  // Pre-load manifest in background for fast modal open
  loadManifest();
}

/* ─── Simulation Wiring (public + admin) ────────────────────── */
function wireSimulations() {
  // Listen for export data from simulation iframes
  if (!window._simMessageListenerAttached) {
    window._simMessageListenerAttached = true;
    window.addEventListener('message', (e) => {
      if (e.data?.type === 'sim-export' && e.data.widgetId) {
        _simExportData[e.data.widgetId] = e.data.data || [];
        downloadSimCSV(e.data.widgetId);
      }
    });
  }

  // Toggle code editor panel
  document.querySelectorAll('.cb-sim-toggle-code').forEach(btn => {
    btn.addEventListener('click', () => {
      const wid = btn.dataset.widgetId;
      const panel = btn.closest('.cb-sim-container')?.querySelector('.cb-sim-code-panel[data-widget-id="' + wid + '"]');
      if (!panel) return;
      const visible = panel.style.display !== 'none';
      panel.style.display = visible ? 'none' : 'block';
      btn.textContent = visible ? 'Edit Code' : 'Hide Code';
    });
  });

  // Run button — re-render iframe with student's edited code
  document.querySelectorAll('.cb-sim-run').forEach(btn => {
    btn.addEventListener('click', () => {
      const wid = btn.dataset.widgetId;
      const container = btn.closest('.cb-sim-container');
      const ta = container?.querySelector('.cb-sim-student-code[data-widget-id="' + wid + '"]');
      const iframe = container?.querySelector('.cb-sim-iframe[data-widget-id="' + wid + '"]');
      if (!ta || !iframe) return;
      const lang = container.dataset.lang || 'html';
      const fn = lang === 'python' ? buildPythonSrcdoc : buildSimSrcdoc;
      iframe.srcdoc = fn(ta.value, wid);
      _simExportData[wid] = [];
    });
  });

  // Reset button — restore original admin code
  document.querySelectorAll('.cb-sim-reset').forEach(btn => {
    btn.addEventListener('click', () => {
      const wid = btn.dataset.widgetId;
      const widget = findWidgetById(wid);
      if (!widget) return;
      const container = btn.closest('.cb-sim-container');
      const ta = container?.querySelector('.cb-sim-student-code[data-widget-id="' + wid + '"]');
      const iframe = container?.querySelector('.cb-sim-iframe[data-widget-id="' + wid + '"]');
      if (ta) ta.value = widget.code || '';
      if (iframe) {
        const lang = container?.dataset.lang || widget.lang || 'html';
        const fn = lang === 'python' ? buildPythonSrcdoc : buildSimSrcdoc;
        iframe.srcdoc = fn(widget.code || '', wid);
      }
      _simExportData[wid] = [];
    });
  });

  // Export data button — ask iframe to flush, then download
  document.querySelectorAll('.cb-sim-export').forEach(btn => {
    btn.addEventListener('click', () => {
      const wid = btn.dataset.widgetId;
      const container = btn.closest('.cb-sim-container');
      const iframe = container?.querySelector('.cb-sim-iframe[data-widget-id="' + wid + '"]');
      if (!iframe?.contentWindow) { alert('Simulation not loaded.'); return; }
      // Tell iframe to flush its data
      iframe.contentWindow.postMessage({ type: 'sim-flush' }, '*');
      // Data will arrive via the message listener above → triggers downloadSimCSV
    });
  });

  // Fullscreen button
  document.querySelectorAll('.cb-sim-fullscreen').forEach(btn => {
    btn.addEventListener('click', () => {
      const container = btn.closest('.cb-sim-container');
      if (!container) return;
      if (container.requestFullscreen) container.requestFullscreen();
      else if (container.webkitRequestFullscreen) container.webkitRequestFullscreen();
    });
  });

  // srcdoc is now set inline via escAttr() in the HTML — no post-render patching needed.
}

/** Convert simulation export data to CSV and trigger download */
function downloadSimCSV(widgetId) {
  const data = _simExportData[widgetId];
  if (!data || !data.length) { alert('No data exported from this simulation yet.\n\nUse SimExport.log(label, value) in your simulation code to log data.'); return; }
  const headers = ['timestamp', 'label', 'value'];
  let csv = headers.join(',') + '\n';
  data.forEach(row => {
    csv += [row.t, '"' + String(row.label).replace(/"/g, '""') + '"', row.value].join(',') + '\n';
  });
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const widget = findWidgetById(widgetId);
  a.download = (widget?.title || 'simulation') + '_data.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* ─── Add Section / Widget Dropdowns ─────────────────────────── */
function wireAddDropdowns() {
  // Add Section dropdown
  const secBtn = document.getElementById('cb-add-section-btn');
  const secDrop = document.getElementById('cb-section-dropdown');
  secBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    closeAllDropdowns();
    secDrop?.classList.toggle('cb-dropdown-open');
  });

  secDrop?.querySelectorAll('.cb-dropdown-item').forEach(item => {
    item.addEventListener('click', () => {
      if (item.disabled) return;
      addSection(item.dataset.addKey);
      closeAllDropdowns();
    });
  });

  // Add Widget dropdowns (one per section)
  document.querySelectorAll('.cb-add-widget-trigger').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeAllDropdowns();
      const menu = btn.closest('.cb-mobile-dropdown')?.querySelector('.cb-widget-dropdown-menu');
      menu?.classList.toggle('cb-dropdown-open');
    });
  });

  document.querySelectorAll('.cb-widget-dropdown-menu .cb-dropdown-item').forEach(item => {
    item.addEventListener('click', () => {
      const sectionId = item.closest('.cb-add-widget-bar')?.querySelector('.cb-add-widget-trigger')?.dataset.sectionId;
      if (sectionId) addWidget(sectionId, item.dataset.addKey);
      closeAllDropdowns();
    });
  });

  // Close dropdowns on outside click
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.cb-mobile-dropdown')) closeAllDropdowns();
  }, { capture: false });
}

function closeAllDropdowns() {
  document.querySelectorAll('.cb-dropdown-menu').forEach(d => d.classList.remove('cb-dropdown-open'));
}

/* ================================================================
   FILE / IMAGE HANDLERS
   ================================================================ */
async function handleFileUpload(btn) {
  const sectionId = btn.dataset.sectionId;
  const sec = findSectionById(sectionId);
  const sectionEl = btn.closest('.cb-section');
  const fileInput = sectionEl?.querySelector('.cb-file-input');
  const file = fileInput?.files?.[0];
  if (!file) { alert('Select a file first.'); return; }
  if (file.size > 50 * 1024 * 1024) { alert('File too large (50 MB max).'); return; }

  const reg = sec ? SECTION_REG[sec.key] : null;
  const filePath = sec?.storagePath || reg?.path || sec?.key || sectionId;
  const st = sectionEl.querySelector('.cb-file-status');
  if (st) st.textContent = 'Uploading...';
  const storagePath = `classes/${_scheduleId}/${filePath}/${Date.now()}_${file.name}`;

  try {
    const ref = firebase.storage().ref(storagePath);
    await ref.put(file);
    const url = await ref.getDownloadURL();
    const Auth = McgheeLab.Auth;
    await ScheduleDB.addFile({
      classId: _scheduleId, section: filePath,
      fileName: file.name, fileUrl: url, storagePath, fileSize: file.size, contentType: file.type,
      description: sectionEl.querySelector('.cb-file-desc')?.value?.trim() || '',
      dueDate: sectionEl.querySelector('.cb-file-due')?.value || null,
      uploadedBy: Auth?.currentUser?.uid || null,
      uploadedByName: _currentSpeaker?.speakerName || Auth?.currentProfile?.name || 'Unknown'
    });
    if (st) st.textContent = 'Uploaded!';
    fileInput.value = '';
    const descInput = sectionEl.querySelector('.cb-file-desc');
    if (descInput) descInput.value = '';
    setTimeout(() => { if (st) st.textContent = ''; }, 2000);
    // Refresh file list
    _fileData[sectionId] = await ScheduleDB.getFiles(_scheduleId, filePath);
    const listEl = sectionEl.querySelector('.cb-file-list');
    if (listEl) {
      listEl.innerHTML = buildFileListHTML(_fileData[sectionId], reg);
      listEl.querySelectorAll('.cb-file-delete').forEach(b => b.addEventListener('click', () => handleFileDelete(b)));
    }
  } catch (e) { if (st) st.textContent = 'Upload failed.'; console.error(e); }
}

async function handleFileDelete(btn) {
  if (!confirm('Delete this file?')) return;
  const sectionEl = btn.closest('.cb-section');
  const sectionId = sectionEl?.dataset.sectionId;
  const sec = sectionId ? findSectionById(sectionId) : null;
  const listEl = sectionEl?.querySelector('.cb-file-list');
  try {
    await ScheduleDB.deleteFile(btn.dataset.fileId, btn.dataset.storagePath);
    if (sec) {
      const reg = SECTION_REG[sec.key];
      const filePath = sec.storagePath || reg?.path || sec.key;
      _fileData[sectionId] = await ScheduleDB.getFiles(_scheduleId, filePath);
      if (listEl) {
        listEl.innerHTML = buildFileListHTML(_fileData[sectionId], reg);
        listEl.querySelectorAll('.cb-file-delete').forEach(b => b.addEventListener('click', () => handleFileDelete(b)));
      }
    }
  } catch (e) { alert('Failed to delete.'); }
}

async function handleImageUpload(input) {
  const widgetId = input.dataset.widgetId;
  const widget = findWidgetById(widgetId);
  const widgetEl = document.querySelector(`.cb-widget[data-widget-id="${widgetId}"]`);
  if (!widget || !input.files?.[0]) return;
  const file = input.files[0];
  if (file.size > 10 * 1024 * 1024) { alert('Image too large (10 MB max).'); return; }

  const st = widgetEl?.querySelector('.cb-image-status');
  if (st) st.textContent = 'Uploading...';
  const storagePath = `classes/${_scheduleId}/widgets/${widgetId}_${Date.now()}`;
  try {
    const ref = firebase.storage().ref(storagePath);
    await ref.put(file);
    widget.url = await ref.getDownloadURL();
    widget.storagePath = storagePath;
    markDirty();
    if (st) st.textContent = 'Uploaded!';
    setTimeout(() => { gatherContentFromDOM(); refreshCanvas(); }, 500);
  } catch (e) { if (st) st.textContent = 'Upload failed.'; console.error(e); }
}

/* ================================================================
   DRAG AND DROP (sections in canvas + widgets in sections)
   ================================================================ */
function initDragAndDrop() {
  const canvas = document.getElementById('cb-canvas');
  if (!canvas) return;

  /* ── Section DnD ─────────────────────────────────────────── */
  // Section handles enable drag on parent section
  canvas.querySelectorAll('.cb-section-handle').forEach(handle => {
    handle.addEventListener('mousedown', () => {
      handle.closest('.cb-section')?.setAttribute('draggable', 'true');
    });
  });

  // Section drag events
  canvas.querySelectorAll('.cb-section').forEach(sec => {
    sec.addEventListener('dragstart', (e) => {
      if (!sec.getAttribute('draggable')) { e.preventDefault(); return; }
      e.dataTransfer.setData('text/plain', JSON.stringify({
        source: 'section', sectionId: sec.dataset.sectionId
      }));
      e.dataTransfer.effectAllowed = 'move';
      sec.classList.add('cb-dragging');
      setTimeout(() => { sec.style.opacity = '0.3'; }, 0);
    });
    sec.addEventListener('dragend', () => {
      sec.classList.remove('cb-dragging');
      sec.style.opacity = '';
      sec.removeAttribute('draggable');
      removeDropIndicators();
    });
  });

  /* ── Widget DnD ──────────────────────────────────────────── */
  // Widget handles enable drag on parent widget
  canvas.querySelectorAll('.cb-widget-handle').forEach(handle => {
    handle.addEventListener('mousedown', () => {
      handle.closest('.cb-widget')?.setAttribute('draggable', 'true');
    });
  });

  // Widget drag events — stopPropagation so section doesn't capture them
  canvas.querySelectorAll('.cb-widget').forEach(wEl => {
    wEl.addEventListener('dragstart', (e) => {
      if (!wEl.getAttribute('draggable')) { e.preventDefault(); return; }
      e.stopPropagation();
      e.dataTransfer.setData('text/plain', JSON.stringify({
        source: 'widget', widgetId: wEl.dataset.widgetId, fromSection: wEl.dataset.parentSection
      }));
      e.dataTransfer.effectAllowed = 'move';
      wEl.classList.add('cb-dragging');
      setTimeout(() => { wEl.style.opacity = '0.3'; }, 0);
    });
    wEl.addEventListener('dragend', () => {
      wEl.classList.remove('cb-dragging');
      wEl.style.opacity = '';
      wEl.removeAttribute('draggable');
      removeDropIndicators();
    });
  });

  /* ── Widget drop zones (each .cb-widgets-area) ───────────── */
  canvas.querySelectorAll('.cb-widgets-area').forEach(area => {
    area.addEventListener('dragover', (e) => {
      // Only accept widget drags — check if a widget is being dragged
      if (!canvas.querySelector('.cb-widget.cb-dragging')) return;
      e.preventDefault();
      e.stopPropagation();
      showWidgetDropIndicator(area, e.clientY);
    });
    area.addEventListener('dragleave', (e) => {
      if (!area.contains(e.relatedTarget)) removeDropIndicators();
    });
    area.addEventListener('drop', (e) => {
      if (!canvas.querySelector('.cb-widget.cb-dragging')) return;
      e.preventDefault();
      e.stopPropagation();
      removeDropIndicators();
      const dropIdx = getWidgetDropIndex(area, e.clientY);
      const toSectionId = area.dataset.sectionId;
      try {
        const data = JSON.parse(e.dataTransfer.getData('text/plain'));
        if (data.source === 'widget' && toSectionId) {
          reorderWidgetDnD(data.widgetId, data.fromSection, toSectionId, dropIdx);
        }
      } catch (err) { console.warn('Widget drop error:', err); }
    });
  });

  /* ── Section drop zone (canvas level) ────────────────────── */
  canvas.addEventListener('dragover', (e) => {
    // Only show section indicators when a section is being dragged
    if (!canvas.querySelector('.cb-section.cb-dragging')) return;
    e.preventDefault();
    showSectionDropIndicator(canvas, e.clientY);
  });
  canvas.addEventListener('dragleave', (e) => {
    if (!canvas.contains(e.relatedTarget)) removeDropIndicators();
  });
  canvas.addEventListener('drop', (e) => {
    if (!canvas.querySelector('.cb-section.cb-dragging')) return;
    e.preventDefault();
    removeDropIndicators();
    const dropIdx = getSectionDropIndex(canvas, e.clientY);
    try {
      const data = JSON.parse(e.dataTransfer.getData('text/plain'));
      if (data.source === 'section') reorderSection(data.sectionId, dropIdx);
    } catch (err) { console.warn('Section drop error:', err); }
  });

  /* ── Cleanup draggable on mouseup ────────────────────────── */
  document.addEventListener('mouseup', () => {
    canvas.querySelectorAll('[draggable="true"]:not(.cb-dragging)').forEach(el => el.removeAttribute('draggable'));
  });
}

/* ─── Section drop helpers ───────────────────────────────────── */
function showSectionDropIndicator(canvas, clientY) {
  removeDropIndicators();
  const sections = [...canvas.querySelectorAll('.cb-section:not(.cb-dragging)')];
  let before = null;
  for (const s of sections) {
    const rect = s.getBoundingClientRect();
    if (clientY < rect.top + rect.height / 2) { before = s; break; }
  }
  const ind = document.createElement('div');
  ind.className = 'cb-drop-indicator';
  if (before) canvas.insertBefore(ind, before);
  else canvas.appendChild(ind);
}

function getSectionDropIndex(canvas, clientY) {
  const sections = [...canvas.querySelectorAll('.cb-section:not(.cb-dragging)')];
  for (let i = 0; i < sections.length; i++) {
    const rect = sections[i].getBoundingClientRect();
    if (clientY < rect.top + rect.height / 2) return i;
  }
  return sections.length;
}

/* ─── Widget drop helpers ────────────────────────────────────── */
function showWidgetDropIndicator(area, clientY) {
  removeDropIndicators();
  const widgets = [...area.querySelectorAll('.cb-widget:not(.cb-dragging)')];
  let before = null;
  for (const w of widgets) {
    const rect = w.getBoundingClientRect();
    if (clientY < rect.top + rect.height / 2) { before = w; break; }
  }
  const ind = document.createElement('div');
  ind.className = 'cb-drop-indicator';
  if (before) area.insertBefore(ind, before);
  else area.appendChild(ind);
}

function getWidgetDropIndex(area, clientY) {
  const widgets = [...area.querySelectorAll('.cb-widget:not(.cb-dragging)')];
  for (let i = 0; i < widgets.length; i++) {
    const rect = widgets[i].getBoundingClientRect();
    if (clientY < rect.top + rect.height / 2) return i;
  }
  return widgets.length;
}

function removeDropIndicators() {
  document.querySelectorAll('.cb-drop-indicator').forEach(el => el.remove());
}

/* ─── Widget DnD reorder (supports cross-section moves) ──────── */
function reorderWidgetDnD(widgetId, fromSectionId, toSectionId, newIndex) {
  const tab = getActiveTab();
  if (!tab) return;
  gatherContentFromDOM();
  const fromSec = (tab.sections || []).find(s => s.id === fromSectionId);
  const toSec = (tab.sections || []).find(s => s.id === toSectionId);
  if (!fromSec || !toSec) return;
  const oldIdx = (fromSec.widgets || []).findIndex(w => w.id === widgetId);
  if (oldIdx === -1) return;
  const [widget] = fromSec.widgets.splice(oldIdx, 1);
  toSec.widgets = toSec.widgets || [];
  // Adjust index if moving within same section
  const adj = (fromSectionId === toSectionId && newIndex > oldIdx) ? newIndex - 1 : newIndex;
  toSec.widgets.splice(Math.max(0, Math.min(adj, toSec.widgets.length)), 0, widget);
  markDirty();
  refreshCanvas();
}

/* ================================================================
   TAB MANAGEMENT
   ================================================================ */
function addTab() {
  const name = prompt('New tab name:', 'New Tab');
  if (!name || !name.trim()) return;
  gatherContentFromDOM();
  const tab = { id: genTabId(), name: name.trim(), sections: [] };
  _tabs.push(tab);
  _activeTabId = tab.id;
  markDirty();
  refreshCanvas();
}

function deleteTab(tabId) {
  if (_tabs.length <= 1) { alert('Cannot delete the last tab.'); return; }
  if (!confirm('Delete this tab and all its content?')) return;
  gatherContentFromDOM();
  _tabs = _tabs.filter(t => t.id !== tabId);
  if (_activeTabId === tabId) _activeTabId = _tabs[0]?.id;
  markDirty();
  refreshCanvas();
}

function renameTab(tabId) {
  const tab = _tabs.find(t => t.id === tabId);
  if (!tab) return;
  const newName = prompt('Tab name:', tab.name);
  if (newName && newName.trim() && newName.trim() !== tab.name) {
    tab.name = newName.trim();
    markDirty();
    refreshCanvas();
  }
}

function switchTab(tabId) {
  if (tabId === _activeTabId) return;
  gatherContentFromDOM();
  _activeTabId = tabId;
  // V3.251 — detach the admin-dashboard live listener when navigating
  // off that tab; wireBme295cAdminDash re-attaches it on re-entry.
  const nextTab = _tabs.find(t => t.id === tabId);
  const nextIsDash = nextTab?.sections?.some(s => s.key === 'adminDash295c');
  if (!nextIsDash) {
    detachBmeDashboardListener();
    detachBmeAssessmentsListener();
  }
  refreshCanvas();
}

/* ================================================================
   SECTION MANAGEMENT
   ================================================================ */
function addSection(key) {
  const tab = getActiveTab();
  if (!tab) return;
  const reg = SECTION_REG[key];
  const defaultName = reg?.label || key;
  const name = prompt('Section name:', defaultName);
  if (!name || !name.trim()) return;
  gatherContentFromDOM();
  tab.sections = tab.sections || [];
  const sec = { key, id: genBlockId(), name: name.trim(), collapsed: false, widgets: [], content: '' };
  if (reg?.component === 'files') sec.storagePath = sec.id;
  tab.sections.push(sec);
  markDirty();
  refreshCanvas();
}

function removeSection(sectionId) {
  const tab = getActiveTab();
  if (!tab) return;
  gatherContentFromDOM();
  tab.sections = (tab.sections || []).filter(s => s.id !== sectionId);
  markDirty();
  refreshCanvas();
}

function moveSection(sectionId, direction) {
  const tab = getActiveTab();
  if (!tab?.sections) return;
  gatherContentFromDOM();
  const idx = tab.sections.findIndex(s => s.id === sectionId);
  if (idx === -1) return;
  const newIdx = idx + direction;
  if (newIdx < 0 || newIdx >= tab.sections.length) return;
  const [sec] = tab.sections.splice(idx, 1);
  tab.sections.splice(newIdx, 0, sec);
  markDirty();
  refreshCanvas();
}

function reorderSection(sectionId, newIndex) {
  const tab = getActiveTab();
  if (!tab?.sections) return;
  gatherContentFromDOM();
  const oldIdx = tab.sections.findIndex(s => s.id === sectionId);
  if (oldIdx === -1) return;
  const [sec] = tab.sections.splice(oldIdx, 1);
  const adj = newIndex > oldIdx ? newIndex - 1 : newIndex;
  tab.sections.splice(Math.max(0, Math.min(adj, tab.sections.length)), 0, sec);
  markDirty();
  refreshCanvas();
}

/* ================================================================
   WIDGET MANAGEMENT
   ================================================================ */
function addWidget(sectionId, kind) {
  const tab = getActiveTab();
  if (!tab) return;
  const sec = (tab.sections || []).find(s => s.id === sectionId);
  if (!sec) return;
  gatherContentFromDOM();
  sec.widgets = sec.widgets || [];
  const widget = { kind, id: genBlockId() };
  if (kind === 'text') widget.content = '';
  else if (kind === 'image') { widget.url = ''; widget.caption = ''; }
  else if (kind === 'video') { widget.url = ''; widget.caption = ''; }
  else if (kind === 'links') widget.items = [{ label: '', url: '' }];
  else if (kind === 'embed') widget.html = '';
  else if (kind === 'simulation') { widget.code = ''; widget.title = ''; widget.lang = 'html'; }
  sec.widgets.push(widget);
  markDirty();
  refreshCanvas();
}

function removeWidget(widgetId) {
  const sec = findSectionForWidget(widgetId);
  if (!sec) return;
  gatherContentFromDOM();
  sec.widgets = (sec.widgets || []).filter(w => w.id !== widgetId);
  markDirty();
  refreshCanvas();
}

function moveWidget(widgetId, direction) {
  const sec = findSectionForWidget(widgetId);
  if (!sec?.widgets) return;
  gatherContentFromDOM();
  const idx = sec.widgets.findIndex(w => w.id === widgetId);
  if (idx === -1) return;
  const newIdx = idx + direction;
  if (newIdx < 0 || newIdx >= sec.widgets.length) return;
  const [widget] = sec.widgets.splice(idx, 1);
  sec.widgets.splice(newIdx, 0, widget);
  markDirty();
  refreshCanvas();
}

/* ================================================================
   REFRESH
   ================================================================ */
function refreshCanvas() {
  const content = document.getElementById('class-page-content');
  if (!content) return;
  // V3.716 — re-home any module orphaned by a just-deleted section before we
  // render, so its lessons show up in the first modules section rather than
  // vanishing from the UI.
  ensureModulePlacements();
  ensureModuleTypes();       // V3.803
  ensureTypedModuleTabs();   // V3.803
  content.innerHTML = buildCanvasHTML();
  wireCanvas();
}

/* ================================================================
   CONTENT GATHERING (read DOM editors → module state)
   ================================================================ */
function gatherContentFromDOM() {
  // Text section content (stored per-section on section object)
  document.querySelectorAll('.cb-section-text[data-section-id]').forEach(ta => {
    const sec = findSectionById(ta.dataset.sectionId);
    if (sec) sec.content = ta.value;
  });
  // Widget text
  document.querySelectorAll('.cb-widget-text').forEach(ta => {
    const w = findWidgetById(ta.dataset.widgetId);
    if (w) w.content = ta.value;
  });
  // Widget video
  document.querySelectorAll('.cb-video-url').forEach(inp => {
    const w = findWidgetById(inp.dataset.widgetId);
    if (w) w.url = inp.value;
  });
  document.querySelectorAll('.cb-video-caption').forEach(inp => {
    const w = findWidgetById(inp.dataset.widgetId);
    if (w) w.caption = inp.value;
  });
  // Widget image caption
  document.querySelectorAll('.cb-image-caption-input').forEach(inp => {
    const w = findWidgetById(inp.dataset.widgetId);
    if (w) w.caption = inp.value;
  });
  // Widget embed
  document.querySelectorAll('.cb-embed-editor').forEach(ta => {
    const w = findWidgetById(ta.dataset.widgetId);
    if (w) w.html = ta.value;
  });
  // Widget simulation
  document.querySelectorAll('.cb-sim-code').forEach(ta => {
    const w = findWidgetById(ta.dataset.widgetId);
    if (w) w.code = ta.value;
  });
  document.querySelectorAll('.cb-sim-title').forEach(inp => {
    const w = findWidgetById(inp.dataset.widgetId);
    if (w) w.title = inp.value;
  });
  document.querySelectorAll('.cb-sim-lang').forEach(sel => {
    const w = findWidgetById(sel.dataset.widgetId);
    if (w) w.lang = sel.value;
  });
  // Widget links
  document.querySelectorAll('.cb-links-editor').forEach(editor => {
    const w = findWidgetById(editor.dataset.widgetId);
    if (!w) return;
    w.items = [...editor.querySelectorAll('.cb-link-row')].map(row => ({
      label: row.querySelector('.cb-link-label')?.value || '',
      url: row.querySelector('.cb-link-url')?.value || ''
    }));
  });
  // Learning modules — only published checkbox is editable inline
  document.querySelectorAll('.cb-mod-published[data-mod-id]').forEach(cb => {
    const mod = (_classData.modules || []).find(m => m.id === cb.dataset.modId);
    if (mod) mod.published = cb.checked;
  });
  // V3.803 — and the type select on each stack card
  document.querySelectorAll('.cb-mod-type[data-mod-id]').forEach(sel => {
    const mod = (_classData.modules || []).find(m => m.id === sel.dataset.modId);
    if (mod) mod.type = sel.value;
  });
}

/* ================================================================
   AUTOSAVE
   ================================================================ */
function markDirty() {
  _dirty = true;
  const st = document.getElementById('cb-autosave-status');
  if (st) { st.textContent = 'Unsaved'; st.className = 'cb-autosave-status cb-status-dirty'; }
}

function startAutosave() {
  stopAutosave();
  _autosaveTimer = setInterval(() => { if (_dirty) persistAll(); }, 30000);
}

function stopAutosave() {
  if (_autosaveTimer) { clearInterval(_autosaveTimer); _autosaveTimer = null; }
}

async function persistAll() {
  const st = document.getElementById('cb-autosave-status');
  if (st) { st.textContent = 'Saving...'; st.className = 'cb-autosave-status cb-status-saving'; }

  gatherContentFromDOM();

  try {
    const saveData = {
      id: _scheduleId,
      tabs: _tabs,
      sections: tabsToSections(),
      modules: _classData.modules || []
    };
    // BME 295C (V3.244) persists an admin-editable student roster on the schedule doc.
    if (Array.isArray(_classData.studentRoster)) {
      saveData.studentRoster = _classData.studentRoster;
    }
    // V3.270 — also persist the other admin-editable schedule fields so
    // that in-memory edits actually survive the next reload. Previously
    // only `tabs/sections/modules/studentRoster` were included in the
    // saveData payload; `instructors` (photo + bio + contact info edits
    // from the V3.267 Instructors panel), `classAdminEmails` (the V3.247
    // class-admin invite list), and `testMode` (V3.250) were silently
    // dropped here. Firestore's `set(..., { merge: true })` preserves
    // them on the server, but the in-memory changes never reached the
    // server because they weren't in the payload.
    if (Array.isArray(_classData.instructors)) {
      saveData.instructors = _classData.instructors;
    }
    if (Array.isArray(_classData.classAdminEmails)) {
      saveData.classAdminEmails = _classData.classAdminEmails;
    }
    if (typeof _classData.testMode === 'boolean') {
      saveData.testMode = _classData.testMode;
    }
    // V3.271 — same trap fixed in V3.270, this time for the admin's
    // per-speaker discussion gate map. Without this the Open/Lock click
    // would update the in-memory state, render correctly during the
    // session, but vanish on reload.
    if (_classData.discussionState && typeof _classData.discussionState === 'object') {
      saveData.discussionState = _classData.discussionState;
    }
    // V3.272 — same trap again, this time for the YouTube link the
    // admin pastes per speaker on the Talk videos panel.
    if (_classData.speakerVideos && typeof _classData.speakerVideos === 'object') {
      saveData.speakerVideos = _classData.speakerVideos;
    }
    // V3.279 — same trap, per-day attendance map written by the
    // Daily attendance panel (and used by `autoAssignBmeSingleDay`).
    if (_classData.dailyAttendance && typeof _classData.dailyAttendance === 'object') {
      saveData.dailyAttendance = _classData.dailyAttendance;
    }
    // V3.280 — same trap, gradebook (weights + alertness + group
    // discussion-quality stars + per-student comments + excused days).
    if (_classData.grades && typeof _classData.grades === 'object') {
      saveData.grades = _classData.grades;
    }
    // V3.286 — same trap, course-assessment gate ('closed'|'open'|'locked').
    if (typeof _classData.assessmentState === 'string') {
      saveData.assessmentState = _classData.assessmentState;
    }
    await ScheduleDB.saveSchedule(saveData);
    _dirty = false;
    if (st) { st.textContent = 'Saved'; st.className = 'cb-autosave-status cb-status-saved'; }
  } catch (e) {
    console.error('Autosave failed:', e);
    if (st) { st.textContent = 'Save failed'; st.className = 'cb-autosave-status cb-status-error'; }
  }
}

/* ================================================================
   SETTINGS MODAL
   ================================================================ */
function openSettings() {
  let modal = document.getElementById('cb-settings-modal');
  if (modal) modal.remove();

  modal = document.createElement('div');
  modal.id = 'cb-settings-modal';
  modal.className = 'cb-modal-overlay';
  const cd = _classData.classDates || {};
  const DAY_NAMES = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const daysCheckboxes = DAY_NAMES.map((d, i) =>
    `<label class="settings-check"><input type="checkbox" value="${i}" ${(cd.daysOfWeek || []).includes(i) ? 'checked' : ''}> ${d}</label>`
  ).join('');

  modal.innerHTML = `
    <div class="cb-modal">
      <div class="cb-modal-header">
        <h3>Course Settings</h3>
        <button type="button" class="cb-modal-close">&times;</button>
      </div>
      <div class="cb-modal-body">
        <div class="form-group">
          <label>Title</label>
          <input type="text" id="cs-title" value="${esc(_classData.title || '')}" />
        </div>
        <div class="form-group">
          <label>Subtitle</label>
          <input type="text" id="cs-subtitle" value="${esc(_classData.subtitle || '')}" />
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
          <div class="form-group">
            <label>Semester</label>
            <input type="text" id="cs-semester" value="${esc(_classData.semester || '')}" />
          </div>
          <div class="form-group">
            <label>Level</label>
            <input type="text" id="cs-level" value="${esc(_classData.level || '')}" placeholder="e.g., Graduate" />
          </div>
        </div>
        <div class="form-group">
          <label>Description</label>
          <textarea id="cs-description" rows="3">${esc(_classData.description || '')}</textarea>
        </div>
        <hr style="border-color:rgba(255,255,255,.08);margin:16px 0;" />
        <h4>Class Schedule</h4>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
          <div class="form-group">
            <label>Start Date</label>
            <input type="date" id="cs-start-date" value="${esc(cd.startDate || '')}" />
          </div>
          <div class="form-group">
            <label>End Date</label>
            <input type="date" id="cs-end-date" value="${esc(cd.endDate || '')}" />
          </div>
        </div>
        <div class="form-group">
          <label>Days of Week</label>
          <div id="cs-days" style="display:flex;gap:6px;flex-wrap:wrap;">${daysCheckboxes}</div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;">
          <div class="form-group">
            <label>Start Time</label>
            <input type="time" id="cs-start-time" value="${esc(cd.startTime || '09:00')}" />
          </div>
          <div class="form-group">
            <label>End Time</label>
            <input type="time" id="cs-end-time" value="${esc(cd.endTime || '10:30')}" />
          </div>
          <div class="form-group">
            <label>Frequency</label>
            <select id="cs-frequency">
              <option value="weekly" ${cd.frequency === 'weekly' ? 'selected' : ''}>Weekly</option>
              <option value="biweekly" ${cd.frequency === 'biweekly' ? 'selected' : ''}>Biweekly</option>
              <option value="monthly" ${cd.frequency === 'monthly' ? 'selected' : ''}>Monthly</option>
              <option value="once" ${cd.frequency === 'once' ? 'selected' : ''}>One-time</option>
            </select>
          </div>
        </div>
        <hr style="border-color:rgba(255,255,255,.08);margin:16px 0;" />
        <div class="form-group">
          <label>Registration Link</label>
          <input type="url" id="cs-reg-link" value="${esc(_classData.registrationLink || '')}" placeholder="https://..." />
        </div>
        <div style="margin-top:16px;">
          <button type="button" id="cs-save-btn" class="btn btn-primary">Save Settings</button>
          <span id="cs-save-status" class="save-status"></span>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  modal.querySelector('.cb-modal-close').addEventListener('click', () => modal.remove());
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

  document.getElementById('cs-save-btn').addEventListener('click', async () => {
    const st = document.getElementById('cs-save-status');
    st.textContent = 'Saving...';
    try {
      const daysOfWeek = [...document.querySelectorAll('#cs-days input:checked')].map(cb => parseInt(cb.value));
      const classDates = {
        startDate: document.getElementById('cs-start-date').value || '',
        endDate: document.getElementById('cs-end-date').value || '',
        daysOfWeek,
        startTime: document.getElementById('cs-start-time').value || '09:00',
        endTime: document.getElementById('cs-end-time').value || '10:30',
        frequency: document.getElementById('cs-frequency').value || 'weekly'
      };
      const updates = {
        id: _scheduleId,
        title: document.getElementById('cs-title').value.trim(),
        subtitle: document.getElementById('cs-subtitle').value.trim(),
        semester: document.getElementById('cs-semester').value.trim(),
        level: document.getElementById('cs-level').value.trim(),
        description: document.getElementById('cs-description').value.trim(),
        classDates,
        registrationLink: document.getElementById('cs-reg-link').value.trim()
      };
      await ScheduleDB.saveSchedule(updates);
      Object.assign(_classData, updates);
      const titleEl = document.getElementById('sched-title');
      const subtitleEl = document.getElementById('sched-subtitle');
      if (titleEl) titleEl.textContent = _classData.title || 'Schedule';
      if (subtitleEl) subtitleEl.innerHTML = esc(_classData.subtitle || '') + (_classData.semester ? ' &mdash; ' + esc(_classData.semester) : '');
      st.textContent = 'Saved!';
      setTimeout(() => modal.remove(), 1000);
    } catch (e) { st.textContent = 'Error: ' + e.message; }
  });
}

/* ================================================================
   SCHEDULER CONFIG
   ================================================================ */
function buildSchedulerConfig() {
  return {
    scheduleId: _scheduleId,
    schedule: _classData,
    speakers: _speakers,
    currentSpeaker: _currentSpeaker,
    viewType: _viewType,
    useKeyAuth: _useKeyAuth,
    adminViewMode: _adminViewMode,
    previewSpeakerIdx: _previewSpeakerIdx,
    buildInviteURL,
    onSaveSpeaker: async (id, data, isKeyAuth) => {
      if (isKeyAuth) await ScheduleDB.updateSpeakerByKey(id, data);
      else await ScheduleDB.updateSpeaker(id, data);
    },
    onSaveSchedule: async (data) => { await ScheduleDB.saveSchedule(data); },
    onAddSpeaker: async (data) => { await ScheduleDB.addSpeaker(data); },
    onDeleteSpeaker: async (id) => { await ScheduleDB.deleteSpeaker(id); },
    onRefresh: async () => { await wireClassPage(_scheduleId); },
    onSwitchView: (mode, speakerIdx) => {
      _adminViewMode = mode;
      _previewSpeakerIdx = speakerIdx || 0;
      refreshCanvas();
    }
  };
}

/* ================================================================
   MODULE VIEWER — iframe wrapper for standalone lesson HTML files
   Route: #/classes/{classId}/modules/{placementId}
     V3.716 — the trailing segment is a modules[] placement id. A bare filename
     is still accepted (pre-V3.716 links, teacher-class lists, hw466ModuleHref);
     see the resolve in wireModuleViewer. This shell ignores the segment
     entirely — wireModuleViewer fills in every field.
   ================================================================ */
function renderModuleViewer(classId, modRef) {
  // iframe src is set by wireModuleViewer after looking up the folder from Firestore
  //
  // V3.682 — `allow-downloads` in the sandbox below is REQUIRED, not polish.
  // Every assessment module turns in by exporting a JSON file (blob →
  // a.download → a.click()), and Chrome silently blocks that inside a
  // sandboxed iframe without this token: no file, no console error, and the
  // module still prints "Exported PRETEST_… — upload it to the D2L dropbox".
  // So a student who opened the pretest from the Learning Modules tab instead
  // of a direct link was told they had a file they did not have. Verified
  // three ways: no-sandbox control downloads, this sandbox without the token
  // does not, this sandbox with it does.
  return `
    <div class="cb-module-viewer-page">
      <div class="cb-module-nav-bar" id="cb-module-nav-bar">
        <a href="#/classes/${esc(classId)}" class="cb-module-back">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>
          <span id="cb-module-class-title">Back to Class</span>
        </a>
        <div class="cb-module-center">
          <span class="cb-module-progress" id="cb-module-progress"></span>
          <span class="cb-module-title" id="cb-module-title"></span>
        </div>
        <div class="cb-module-nav" id="cb-module-nav"></div>
      </div>
      <div class="cb-module-iframe-wrap">
        <iframe
          id="cb-module-iframe"
          class="cb-module-iframe"
          sandbox="allow-scripts allow-same-origin allow-popups allow-forms allow-downloads"
        ></iframe>
      </div>
    </div>
  `;
}

/* V3.716 — `modRef` is a module *placement* id (`mod_xxxxxxxx`), or, for
   pre-V3.716 links, teacher-class lists and hw466ModuleHref, a bare filename.
   Resolved id-first so two sections holding the same lesson file are two
   distinct pages with two distinct folders. */
async function wireModuleViewer(classId, modRef) {
  try {
    // V3.656 — resolve through resolveSchedule() rather than reading Firestore
    // directly. The old code did `.doc(classId).get()` and bailed on
    // `!doc.exists`, which meant a class seeded in DEFAULT_SCHEDULES rendered
    // its class page correctly (renderClassPage/wireClassPage DO fall back) but
    // every module link opened a silently blank iframe until someone saved the
    // doc to Firestore. resolveSchedule() handles demo classes, Firestore, and
    // the DEFAULT_SCHEDULES fallback in one place, so the two paths agree.
    const schedule = await resolveSchedule(classId);
    if (!schedule) return;

    // V3.304 — soft gate for external teacher classes: only enrolled
    // students, the owning teacher, or an admin may open the viewer.
    // (Module HTML itself stays a public static asset — accepted
    // trade-off, see the V3.304 plan.)
    if (schedule.kind === 'teacher-class' && McgheeLab.tcCanViewModules) {
      const ok = await McgheeLab.tcCanViewModules(classId, schedule);
      if (!ok) {
        const wrap = document.querySelector('.cb-module-iframe-wrap');
        if (wrap) {
          wrap.innerHTML = `
            <div class="tc-gate-card" style="margin:2rem auto;max-width:480px;text-align:center;">
              <h3>This module is part of a class</h3>
              <p class="muted-text">Sign in and enter your class code to view it.</p>
              <a class="btn btn-primary" href="#/classes/${esc(classId)}">Go to class page</a>
            </div>`;
        }
        const titleEl2 = document.getElementById('cb-module-class-title');
        if (titleEl2) titleEl2.textContent = schedule.title || classId;
        return;
      }
    }

    const modules = (schedule.modules || [])
      .filter(m => m.published)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

    /* V3.716 — placement id first, filename second. `current` decides both the
       folder and the file, so a link to one placement can never open the other
       placement's copy of the same filename. */
    const current = modules.find(m => m.id === modRef)
                 || modules.find(m => m.htmlFile === modRef)
                 || null;

    /* Prev/next walk the placement's OWN section, so "next lesson" stays inside
       the section the student is reading.

       This reads the schedule doc directly, so it applies the same adoption
       rule the class page's normalizer does rather than trusting `sectionId`
       to be present: an entry without one belongs to the first Learning
       Modules section. Without this, a class whose doc had not yet been
       re-saved since V3.716 would show sectioned lists on the class page but
       class-wide prev/next in the viewer. A teacher-class has no modules
       section at all, so `homeSectionId` is null and every entry falls back to
       the full published list — exactly the pre-V3.716 behaviour. */
    const homeSectionId = (schedule.tabs || [])
      .flatMap(t => t.sections || [])
      .find(s => s.key === 'modules')?.id || null;
    const sectionOf = (m) => m.sectionId || homeSectionId;
    /* V3.803 — a listed entry (homework, key, report, test) navigates within
       its LIST in the order its tab shows, and the lesson stack's prev/next
       skip listed entries, so "Next" from a lesson never lands on a key. */
    const homeOf = (m) => moduleHomeKey(m || {});
    const sectionRank = new Map((schedule.tabs || [])
      .flatMap(t => t.sections || []).filter(s => s.key === 'modules').map((s, i) => [s.id, i]));
    const siblings = homeOf(current)
      ? modules.filter(m => homeOf(m) === homeOf(current))
          .sort((a, b) => ((sectionRank.get(sectionOf(a)) ?? 0) - (sectionRank.get(sectionOf(b)) ?? 0))
                       || ((a.order ?? 0) - (b.order ?? 0)))
      : sectionOf(current || {})
        ? modules.filter(m => !homeOf(m) && sectionOf(m) === sectionOf(current))
        : modules.filter(m => !homeOf(m));
    const currentIdx = current ? siblings.findIndex(m => m.id === current.id) : -1;
    const prev = currentIdx > 0 ? siblings[currentIdx - 1] : null;
    const next = (currentIdx >= 0 && currentIdx < siblings.length - 1) ? siblings[currentIdx + 1] : null;

    // The file to load: from the resolved placement, or the ref itself when it
    // was a filename that matched nothing published.
    const moduleFile = current?.htmlFile || modRef;

    // Set iframe src using the folder from the module data
    const iframe = document.getElementById('cb-module-iframe');
    if (iframe) {
      const folder = current?.folder || classId;
      // V3.684 — `?class=` is how a module learns which class it belongs to.
      // Nothing set it before (module-header.js:52 only built it for its own
      // nav links), so an embedded module had no class context at all. The
      // whiteboard panel needs it to find the class's live board.
      // V3.716 — `&mod=` carries the placement id so the module's own header can
      // build prev/next for the right section. Student state (notes boards,
      // hwProgress) deliberately stays keyed on the lesson, not the placement.
      iframe.src = `modules/${encodeURIComponent(folder)}/${encodeURIComponent(moduleFile)}`
                 + `?class=${encodeURIComponent(classId)}`
                 + (current?.id ? `&mod=${encodeURIComponent(current.id)}` : '');
      iframe.addEventListener('load', () => {
        try {
          // V3.667 — modules with a fixed section rail (#rail: the weekly
          // learning modules) must scroll INSIDE the iframe, or the rail
          // scrolls away with the parent page. Give those a viewport-height
          // iframe; content-height sizing stays for every other module.
          //
          // V3.684 — `<meta name="ml-module-viewport">` opts a module into the
          // same regime. A module with a floating panel needs it: in the
          // scrollHeight regime the iframe is as tall as its whole document,
          // so `position:fixed` inside pins to that, not to the screen, and
          // the panel scrolls away. Detected via <meta> rather than by
          // sniffing for the panel element, because a deferred script builds
          // the panel AFTER this load handler runs — the meta is parsed with
          // the head and is always there. No existing module declares it, so
          // every one of them falls through to exactly today's behaviour.
          const cdoc = iframe.contentDocument;
          if (cdoc?.querySelector('meta[name="ml-module-viewport"]') || cdoc?.getElementById('rail')) {
            iframe.style.height = 'calc(100vh - 120px)'; /* match .cb-module-iframe's chrome allowance */
            return;
          }
          const h = iframe.contentDocument?.documentElement?.scrollHeight;
          if (h) iframe.style.height = h + 'px';
        } catch (e) {
          iframe.style.height = 'calc(100vh - 60px)';
        }
      });
    }

    // Class title
    const titleEl = document.getElementById('cb-module-class-title');
    if (titleEl) titleEl.textContent = schedule.title || classId;

    // Module title + progress
    const modTitle = document.getElementById('cb-module-title');
    const modProgress = document.getElementById('cb-module-progress');
    if (modTitle) modTitle.textContent = current?.title || moduleFile;
    // V3.716 — "Lesson N of M" counts within the section, matching the numbers
    // shown on the class page's own list for that section.
    if (modProgress && currentIdx >= 0) modProgress.textContent = moduleProgressLabel(current, siblings, currentIdx);

    // Prev / Next / Homework nav buttons
    const navEl = document.getElementById('cb-module-nav');
    if (navEl) {
      let navHtml = '';

      if (prev) {
        navHtml += `<a href="#/classes/${esc(classId)}/modules/${encodeURIComponent(prev.id || prev.htmlFile)}" class="cb-module-nav-btn" title="${esc(prev.title)}">&larr; Prev</a>`;
      } else {
        navHtml += '<span class="cb-module-nav-btn cb-module-nav-disabled">&larr; Prev</span>';
      }

      if (current?.homeworkFileId) {
        try {
          const fDoc = await db.collection('classFiles').doc(current.homeworkFileId).get();
          if (fDoc.exists && fDoc.data().fileUrl) {
            navHtml += `<a href="${esc(fDoc.data().fileUrl)}" target="_blank" rel="noopener" class="cb-module-nav-btn cb-module-nav-hw">Homework</a>`;
          }
        } catch (e) { /* skip */ }
      }

      if (next) {
        navHtml += `<a href="#/classes/${esc(classId)}/modules/${encodeURIComponent(next.id || next.htmlFile)}" class="cb-module-nav-btn" title="${esc(next.title)}">Next &rarr;</a>`;
      } else {
        navHtml += '<span class="cb-module-nav-btn cb-module-nav-disabled">Next &rarr;</span>';
      }

      navEl.innerHTML = navHtml;
    }

    // V3.672 — engagement beacon: enrolled teacher-class students only.
    const currentModule = current;
    setupModuleEngagement(classId, schedule, currentModule, iframe).catch(e =>
      console.warn('[ModuleViewer] engagement beacon', e));
  } catch (err) {
    console.warn('[ModuleViewer] Failed to load class data:', err);
  }
}

/* ================================================================
   MODULE ENGAGEMENT BEACON (V3.672 — teacher program R3)
   ----------------------------------------------------------------
   Records, for an ENROLLED teacher-class student only: module opens,
   visibility-aware time-on-module, rail-section progress, and scroll
   depth — into moduleStats/{scheduleId}_{studentUid} via
   TC_DB.recordEngagement (or the demo world's mirror, so demo never
   touches Firestore). Teachers, admins, view-as previews, and
   non-enrolled visitors produce ZERO writes.

   The instrumentation point is the parent, not the modules: the
   viewer iframe is same-origin, so all 47 module files stay untouched
   — rail targets are observed with an IntersectionObserver built from
   the IFRAME's own window (a parent-constructed IO cannot observe a
   foreign document). A `message` listener also accepts the optional
   {source:'ml-module', type:'section', id} protocol (module-header.js
   emits it), deduped against the observer's stream.

   Time is a 15s heartbeat that accrues only while the tab is visible,
   flushed every 60s and on hidden/route-change/pagehide (the ≤60s
   tail on a hard close is accepted — sendBeacon can't carry Firestore
   SDK writes). Teardown self-removes every listener; a new viewer
   visit tears down the previous beacon first, so rapid route changes
   cannot leak intervals.
   ================================================================ */
let _engagementTeardown = null;

async function setupModuleEngagement(classId, schedule, current, iframe) {
  if (_engagementTeardown) { try { _engagementTeardown(); } catch (e) {} _engagementTeardown = null; }
  if (!iframe || !current || !current.id || schedule.kind !== 'teacher-class') return;

  const ML = McgheeLab;
  const demo = ML.TC_DEMO?.active ? ML.TC_DEMO : null;
  if (demo && demo.signedOut) return;
  if (ML.tcViewAsFor && ML.tcViewAsFor(classId)) return;           // teacher preview
  const uid = demo ? demo.uid : ML.Auth?.currentUser?.uid;
  if (!uid) return;
  if (!demo && ML.Auth?.currentProfile?.role === 'admin') return;  // admin browsing
  if (schedule.ownerUid === uid) return;                           // the teacher
  const dataLayer = demo ? demo.db : ML.TC_DB;
  if (!dataLayer?.recordEngagement || !dataLayer.getEnrollment) return;
  const enr = await dataLayer.getEnrollment(classId, uid).catch(() => null);
  if (!enr || enr.status !== 'active') return;

  const student = { uid, name: enr.studentName || '', teacherUid: enr.teacherUid };
  const moduleId = current.id;
  const rec = (patch) => dataLayer
    .recordEngagement(classId, student, Object.assign({ moduleId }, patch))
    .catch(e => console.warn('[ModuleViewer] engagement write', e));

  let seconds = 0;                    // unflushed visible-time
  let ticks = 0;
  const pendingSections = new Set();  // seen, not yet written
  const flushedSections = new Set();  // written this session — don't resend
  let railCount = null;
  let maxScrollPct = 0, flushedScrollPct = 0;
  let observer = null;
  let hooked = false;

  function flush(extra) {
    const patch = Object.assign({}, extra);
    if (seconds > 0) { patch.seconds = seconds; seconds = 0; }
    if (pendingSections.size) {
      patch.sections = [...pendingSections];
      patch.sections.forEach(s => flushedSections.add(s));
      pendingSections.clear();
      if (railCount != null) patch.railCount = railCount;
    }
    if (maxScrollPct > flushedScrollPct) {
      patch.scrollPct = maxScrollPct;
      flushedScrollPct = maxScrollPct;
    }
    if (Object.keys(patch).length) rec(patch);
  }

  rec({ opens: 1 }); // one open per viewer visit

  const interval = setInterval(() => {
    if (!document.body.contains(iframe)) { flush(); teardown(); return; }
    if (document.visibilityState !== 'visible') return;
    seconds += 15;
    if (++ticks % 4 === 0) flush();
  }, 15000);

  function hookContent() {
    if (hooked) return;
    try {
      const doc = iframe.contentDocument;
      if (!doc || doc.location.href === 'about:blank') return;
      hooked = true;
      const rail = doc.getElementById('rail');
      if (rail) {
        const targets = [...rail.querySelectorAll('a[href^="#"]')]
          .map(a => (a.getAttribute('href') || '').slice(1)).filter(Boolean)
          .map(id => doc.getElementById(id)).filter(Boolean);
        railCount = targets.length || null;
        if (targets.length && iframe.contentWindow.IntersectionObserver) {
          observer = new iframe.contentWindow.IntersectionObserver((entries) => {
            for (const en of entries) {
              if (en.isIntersecting && en.target.id && !flushedSections.has(en.target.id)) {
                pendingSections.add(en.target.id);
              }
            }
          }, { threshold: 0.4 });
          targets.forEach(t => observer.observe(t));
        }
        return;
      }
      onScroll(); // non-rail: seed the initial depth
    } catch (e) { /* torn down mid-hook — skip */ }
  }
  function onScroll() {
    if (railCount != null || !hooked) return;
    try {
      const rect = iframe.getBoundingClientRect();
      const h = iframe.offsetHeight || 1;
      const seen = Math.min(h, Math.max(0, window.innerHeight - rect.top));
      const pct = Math.min(100, Math.round((seen / h) * 100));
      if (pct > maxScrollPct) maxScrollPct = pct;
    } catch (e) { /* detached */ }
  }
  iframe.addEventListener('load', hookContent);
  try {
    if (iframe.contentDocument?.readyState === 'complete') hookContent();
  } catch (e) { /* not ready yet — the load listener covers it */ }

  function onMessage(e) {
    if (e.origin !== window.location.origin) return;
    const d = e.data;
    if (d && d.source === 'ml-module' && d.type === 'section' &&
        typeof d.id === 'string' && d.id && !flushedSections.has(d.id)) {
      pendingSections.add(d.id);
    }
  }
  function onVisibility() { if (document.visibilityState === 'hidden') flush(); }
  function onLeave() { flush(); teardown(); }

  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('message', onMessage);
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('hashchange', onLeave);
  window.addEventListener('pagehide', onLeave);

  function teardown() {
    clearInterval(interval);
    iframe.removeEventListener('load', hookContent);
    window.removeEventListener('scroll', onScroll);
    window.removeEventListener('message', onMessage);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('hashchange', onLeave);
    window.removeEventListener('pagehide', onLeave);
    try { if (observer) observer.disconnect(); } catch (e) {}
    if (_engagementTeardown === teardown) _engagementTeardown = null;
  }
  _engagementTeardown = teardown;
}

/* ================================================================
   BME 295C — class-specific section helpers (V3.244)
   ----------------------------------------------------------------
   - Static content (syllabus, speakers, discussion points) comes from
     modules/bme295c/content.json — loaded once per page visit.
   - Student roster + group assignments live on
     schedules/bme295c.studentRoster, admin-edited via the roster
     section.
   - Per-student profile fields (bio, BME interest, photo URL) live on
     users/{uid}.bme295c, writable only by the student.
   ================================================================ */

const BME295C_CONTENT_URL = 'modules/bme295c/content.json';
const BME295C_BASE_PATH   = 'modules/bme295c/';

/** Load content.json + the current user's profile + groupmate profiles. */
async function loadBme295cData(schedule) {
  // Reset every load so a tab switch doesn't leak stale state.
  _bmeContent = null;
  _bmeProfile = null;
  _bmeGroupProfiles = null;
  _bmeRosterEntry = null;
  _bmeBannerFocusDay = null;

  // Is there any 295c section in this schedule?
  const hasAny = (schedule.tabs || []).some(t => (t.sections || []).some(s => {
    const k = SECTION_REG[s.key]?.component || '';
    return k === 'checkin295c' || k === 'syllabus295c' || k === 'schedule295c'
        || k === 'modules295c' || k === 'roster295c' || k === 'assessment295c';
  }));
  if (!hasAny) return;

  // 1. Static content
  try {
    const resp = await fetch(BME295C_CONTENT_URL + '?_=' + Date.now());
    if (resp.ok) _bmeContent = await resp.json();
  } catch (e) {
    console.warn('[BME295C] Failed to load content.json:', e);
  }

  // 2. Match the viewer to a roster entry. V3.248 — when the admin
  // toolbar's view-as override is active, we resolve a synthetic viewer
  // identity instead of the real signed-in user.
  const auth = McgheeLab.Auth;
  const realSignedIn = !!auth?.currentUser;
  const realEmail = realSignedIn ? (auth.currentUser.email || '').toLowerCase() : '';
  const roster = Array.isArray(_classData.studentRoster) ? _classData.studentRoster : [];

  let signedIn = realSignedIn;
  let userEmail = realEmail;
  if (_adminViewOverride?.type === 'public') {
    signedIn = false;
    userEmail = '';
  } else if (_adminViewOverride?.type === 'student') {
    signedIn = true;
    const impersonated = _adminViewOverride.studentId ? roster.find(r => r.id === _adminViewOverride.studentId) : null;
    /* V3.734 — generic student view keeps the admin's own identity */
    userEmail = impersonated ? (impersonated.email || '').toLowerCase() : realEmail;
  }

  if (signedIn && userEmail) {
    _bmeRosterEntry = roster.find(r => (r.email || '').toLowerCase() === userEmail) || null;
  }

  // 3. Current user's profile (from users/{uid}.bme295c). For an
  // impersonated student we'd need their user doc — skipped in V3.248
  // since the dashboard's per-student grid is the right place to inspect
  // a specific student's saved data. Preview just shows an empty bio.
  if (_adminViewOverride) {
    _bmeProfile = { bio: '', interest: '', photoUrl: '', photoStoragePath: '' };
  } else if (signedIn && auth.currentProfile?.bme295c) {
    _bmeProfile = { ...auth.currentProfile.bme295c };
  } else {
    _bmeProfile = { bio: '', interest: '', photoUrl: '', photoStoragePath: '' };
  }

  // 4. Groupmate profiles — union across all course days, since groups
  // rotate daily and the modules tab may show any day's mates inline.
  const hasAnyGroupAssignment = !!_bmeRosterEntry &&
    !!_bmeRosterEntry.campus &&
    (
      (typeof _bmeRosterEntry.groupNumber === 'number') ||
      (_bmeRosterEntry.dailyGroups && Object.values(_bmeRosterEntry.dailyGroups).some(v => typeof v === 'number'))
    );
  if (hasAnyGroupAssignment) {
    const allMates = bmeAllMatesUnion(_bmeRosterEntry).filter(gm => (gm.email || '').trim());
    _bmeGroupProfiles = new Map();
    await Promise.all(allMates.map(async (gm) => {
      try {
        const snap = await McgheeLab.db.collection('users')
          .where('email', '==', gm.email).limit(1).get();
        if (!snap.empty) {
          const data = snap.docs[0].data();
          _bmeGroupProfiles.set(gm.email.toLowerCase(), data.bme295c || null);
        }
      } catch (e) { /* groupmate profile is optional */ }
    }));

    // 5. Pre-load every speaker's group response doc, keyed by that
    // speaker's day's group number (daily rotation). Speakers without an
    // assigned day for this user (e.g. shouldn't happen but defensive)
    // fall back to legacy groupNumber.
    _bmeGroupResponses = new Map();
    const speakers = (_bmeContent?.speakers || []);
    // V3.271 — use effective campus (student's override or roster default)
    // so the prefetch hits the same docs the save path will write to.
    const myCampus = bmeEffectiveCampus(_bmeRosterEntry, _bmeProfile);
    // V3.284 — one-shot integrity check. Surfaces the day-name + campus
    // mismatches the audit caught BEFORE any docs get fetched, so the
    // failure mode is visible in DevTools instead of "submissions don't
    // appear in the live monitor." Logs per-speaker once on each load.
    const validDays = bmeCourseDays();
    speakers.forEach(sp => {
      const day = bmeSpeakerDay(sp.slug);
      if (day && !validDays.includes(day)) {
        console.warn('[bme295c] integrity — speaker', sp.slug, 'day', JSON.stringify(day), 'not in', validDays);
      }
      const gNum = bmeGetGroupForDay(_bmeRosterEntry, day);
      if (!gNum) {
        console.warn('[bme295c] integrity — viewer', _bmeRosterEntry?.id, 'has no group for', sp.slug, 'on day', JSON.stringify(day),
                     'dailyGroups =', _bmeRosterEntry?.dailyGroups);
      }
    });
    await Promise.all(speakers.map(async (sp) => {
      const day = bmeSpeakerDay(sp.slug);
      const gNum = bmeGetGroupForDay(_bmeRosterEntry, day);
      if (!gNum || !myCampus) { _bmeGroupResponses.set(sp.slug, null); return; }
      const docId = bmeResponseDocId(myCampus, gNum, sp.slug);
      try {
        const doc = await McgheeLab.db.collection('schedules').doc(_scheduleId)
          .collection('groupResponses').doc(docId).get();
        _bmeGroupResponses.set(sp.slug, doc.exists ? bmeNormalizeResponse({ id: doc.id, ...doc.data() }) : null);
      } catch (e) {
        _bmeGroupResponses.set(sp.slug, null);
      }
    }));
  }

  // V3.286 — pre-load the current user's course-assessment doc so the
  // form rehydrates with any draft / submitted answers on entry. Skipped
  // for admin view-as-student previews (the admin doesn't own an
  // assessment doc and shouldn't read someone else's via this path).
  _bmeAssessment = null;
  if (signedIn && _bmeRosterEntry && !_adminViewOverride && auth?.currentUser?.uid) {
    try {
      const adoc = await McgheeLab.db.collection('schedules').doc(_scheduleId)
        .collection('assessments').doc(auth.currentUser.uid).get();
      if (adoc.exists) _bmeAssessment = { id: adoc.id, ...adoc.data() };
    } catch (e) {
      // Read denied is normal pre-submit (the rule check `auth.uid == uid`
      // succeeds either way; this catch is for the no-doc case + offline).
      console.warn('[bme295c] assessment prefetch failed', e);
    }
  }
}

/** Compose the deterministic Firestore docId for a group response. */
function bmeResponseDocId(campus, groupNumber, speakerSlug) {
  // V3.284 — defensive guard. The audit found two production-breaking
  // mismatches where docId construction silently produced a key no
  // reader looked at. Warn (don't throw — same trust model as the
  // legacy `entry.groupNumber` fallback) so the failure mode is
  // visible in DevTools instead of silently dropping submissions.
  if (!campus || (campus !== 'Tucson' && campus !== 'Phoenix')) {
    console.warn('[bme295c] bmeResponseDocId — invalid campus:', campus, 'group:', groupNumber, 'slug:', speakerSlug);
  }
  if (typeof groupNumber !== 'number' || !Number.isFinite(groupNumber)) {
    console.warn('[bme295c] bmeResponseDocId — invalid group:', groupNumber, 'campus:', campus, 'slug:', speakerSlug);
  }
  return `${campus}-${groupNumber}-${speakerSlug}`;
}

/** V3.251 — back-compat normalizer: legacy docs store `text` (a single
 * string covering all 3 prompts); new docs store `prompts: {0,1,2}`.
 * Wraps reads so renderers can always assume `prompts`. Lazy migration:
 * a normalized doc only flips to the new shape on the next write — no
 * batch migration job needed.
 */
/** V3.271 — student-self-selected campus override.
 *
 * Campus on `_classData.studentRoster[i].campus` is admin-set (and the
 * Firestore rule on `schedules/{id}` blocks regular students from
 * writing to it). To let students change which campus they'll attend
 * from without rule changes, we let them save a `campus` field on
 * their own user doc at `users/{uid}.bme295c.campus` (writable per the
 * existing `users/{uid}` owner-write rule). Reads pass through this
 * helper, which prefers the student's override when present.
 *
 * For the current viewer's own entry, the override lives in
 * `_bmeProfile.campus`. For other students, callers pass the cached
 * user-doc profile (`_bmeOtherProfileCache.get(entry.id)?.bme295c`
 * or `_bmeDashboardData.profilesByEmail.get(email)?.bme295c`).
 */
function bmeEffectiveCampus(entry, profile) {
  if (profile && profile.campus) return profile.campus;
  return entry?.campus || '';
}

/** V3.284 — single source of truth for "which campus bucket does this
 * student's response live under?" Every admin docId construction MUST
 * call this — using raw `student.campus` is the bug we just fixed, where
 * the save path went through `bmeEffectiveCampus(entry, _bmeProfile)`
 * but admin readers used the unwrapped roster campus, so any student
 * with a campus override produced a doc the gradebook + live monitor
 * couldn't see (V3.272 admin/student split-brain).
 */
function bmeStudentCampus(entry) {
  return bmeEffectiveCampus(entry, bmeProfileFor(entry));
}

/** Resolve the user-doc bme295c profile for a roster entry (via the
 * caches loaded by `loadBmeChatProfiles` + `loadBmeDashboardData`).
 * Returns null when no cache hit. Used to look up `campus` overrides
 * without per-call Firestore reads.
 */
function bmeProfileFor(entry) {
  if (!entry) return null;
  if (_bmeRosterEntry && entry.id === _bmeRosterEntry.id) return _bmeProfile || null;
  const cached = _bmeOtherProfileCache?.get(entry.id);
  if (cached) return cached;
  const email = (entry.email || '').toLowerCase();
  if (email && _bmeDashboardData?.profilesByEmail) {
    const u = _bmeDashboardData.profilesByEmail.get(email);
    if (u?.bme295c) return u.bme295c;
  }
  return null;
}

function bmeNormalizeResponse(raw) {
  if (!raw) return raw;
  if (raw.prompts && typeof raw.prompts === 'object') return raw;
  return { ...raw, prompts: { 0: raw.text || '', 1: '', 2: '' } };
}

/* ─── Daily-group helpers (V3.246) ────────────────────────────
   Each roster entry has `dailyGroups: { Monday: n, Tuesday: n, ... }`.
   `groupNumber` is kept as a legacy fallback (= Monday's group), so
   pre-V3.246 docs and the admin "single number" workflow still work.
   ─────────────────────────────────────────────────────────── */

function bmeCourseDays() {
  // Source of truth = content.json `schedule[].day` (Mon..Fri for V3.246).
  // Fall back to the calendar week if content hasn't loaded yet.
  const days = (_bmeContent?.schedule || []).map(d => d.day).filter(Boolean);
  return days.length ? days : ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
}

function bmeSpeakerDay(speakerSlug) {
  const sp = (_bmeContent?.speakers || []).find(s => s.slug === speakerSlug);
  const raw = sp?.day || null;
  if (!raw) return null;
  // V3.284 — content.json stores `speakers[].day` as "Monday, June 8"
  // (a date + weekday) but `dailyGroups` + the `schedule[].day` list are
  // keyed by the bare weekday ("Monday"). Without this normalization the
  // save path's `bmeGetGroupForDay(entry, bmeSpeakerDay(slug))` always
  // missed and silently dropped every submission. Strip the date suffix
  // at the boundary so downstream code can assume short-form day keys.
  const weekday = raw.split(',')[0].trim();
  const validDays = bmeCourseDays();
  if (validDays.length && !validDays.includes(weekday)) {
    console.warn('[bme295c] bmeSpeakerDay normalized', JSON.stringify(raw), '→', JSON.stringify(weekday),
                 'but that is not in bmeCourseDays() =', validDays, '— check content.json speakers[].day vs schedule[].day');
  }
  return weekday;
}

function bmeGetGroupForDay(entry, day) {
  if (!entry) return null;
  if (entry.dailyGroups && typeof entry.dailyGroups[day] === 'number') {
    return entry.dailyGroups[day];
  }
  // V3.285 — legacy `entry.groupNumber` fallback DROPPED. It was
  // routing every Tue-Fri save to the same docId as Monday whenever
  // admin hadn't auto-assigned past day 1, masquerading as a "save
  // succeeded but admin can't see it" failure. With this fallback gone,
  // unassigned days return null → save path early-returns with a
  // visible "your group has not been assigned" banner (V3.285 Fix 1) →
  // student can ping the admin to fix it before submitting.
  return null;
}

function bmeTodayCourseDay() {
  // Use the schedule's actual date range to decide "today".
  const start = new Date('2026-06-08T00:00:00');
  const end   = new Date('2026-06-12T23:59:59');
  const now = new Date();
  if (now < start || now > end) return null;
  return ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][now.getDay()];
}

function bmeDefaultDisplayDay() {
  // Day used by "current group" UI (check-in, bio modal, banner). Prefer
  // today during the course week; otherwise the first scheduled day.
  return bmeTodayCourseDay() || bmeCourseDays()[0] || 'Monday';
}

function bmeMatesForDay(entry, day) {
  // V3.271 — campus comparison goes through `bmeEffectiveCampus` so a
  // student who self-selected a different campus in their bio is
  // grouped with that campus's roster instead of the admin's default.
  const myCampus = bmeEffectiveCampus(entry, bmeProfileFor(entry));
  if (!entry || !myCampus) return [];
  const roster = Array.isArray(_classData?.studentRoster) ? _classData.studentRoster : [];
  const myGroup = bmeGetGroupForDay(entry, day);
  if (!myGroup) return [];
  return roster.filter(r =>
    bmeEffectiveCampus(r, bmeProfileFor(r)) === myCampus &&
    bmeGetGroupForDay(r, day) === myGroup &&
    r.id !== entry.id
  );
}

function bmeAllMatesUnion(entry) {
  // All distinct students who share a group with `entry` on ANY course day.
  const days = bmeCourseDays();
  const out = new Map();
  for (const d of days) {
    for (const m of bmeMatesForDay(entry, d)) {
      if (m.id !== entry.id) out.set(m.id, m);
    }
  }
  return [...out.values()];
}

/** Resolve an asset path under modules/bme295c/ to a fetchable URL. */
function bmeAssetUrl(rel) {
  if (!rel) return '';
  // encodeURI handles any future filenames with spaces; speaker-photos/ has none.
  return BME295C_BASE_PATH + rel.split('/').map(encodeURIComponent).join('/');
}

/** Plain-text → simple paragraphs with auto-linked URLs. */
function bmePara(text) {
  if (!text) return '';
  return text.split('\n\n').map(p =>
    `<p>${esc(p.trim()).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>')}</p>`
  ).join('');
}

/* ─── Tab 1: Check-in section body ───────────────────────────── */
// Renders a compact button strip: Login (signed out) or "Edit your bio
// and information" (signed in + roster match). The full bio editor
// lives in a modal opened by the latter; sign-in lives on a dedicated
// enrollment page at #/classes/bme295c/enroll.
function renderBmeCheckinBody(section) {
  const auth = McgheeLab.Auth;
  const signedIn = !!auth?.currentUser;
  const isAdmin = auth?.currentProfile?.role === 'admin' || _isClassAdminOnly;
  const entry = _bmeRosterEntry;

  // Signed out → Login button → routes to enrollment page
  if (!signedIn) {
    return `
      <div class="cb295-checkin-strip cb295-checkin-strip-out">
        <div class="cb295-checkin-strip-text">
          <strong>Are you enrolled in BME 295C?</strong>
          <span class="muted-text">Sign in to see your discussion group and edit your profile.</span>
        </div>
        <a href="#/classes/bme295c/enroll" class="btn">Login</a>
      </div>
    `;
  }

  // Signed in, email not on roster
  if (!entry && !isAdmin) {
    return `
      <div class="cb295-checkin-strip cb295-checkin-strip-norostermatch">
        <div class="cb295-checkin-strip-text">
          <strong>Your email isn't on the BME 295C roster</strong>
          <span class="muted-text">Signed in as ${esc(auth.currentUser.email || '')}. Contact <a href="mailto:mcgheealex@gmail.com">mcgheealex@gmail.com</a> if this is a mistake.</span>
        </div>
        <button type="button" class="btn btn-secondary" id="cb295-signout">Sign out</button>
      </div>
    `;
  }

  // V3.254 — admin without a roster entry gets a dedicated strip. The
  // old branch fell through to the student "Welcome … Groups not yet
  // assigned" template, which is misleading because admins are never
  // expected to have a roster row (and therefore no group).
  if (isAdmin && !entry) {
    const adminEmail = (auth.currentUser.email || '').toLowerCase();
    return `
      <div class="cb295-checkin-strip cb295-checkin-strip-in cb295-checkin-strip-admin">
        <div class="cb295-checkin-strip-text">
          <strong>Admin view${_isClassAdminOnly ? ' (class admin)' : ''}</strong>
          <span class="muted-text">${esc(adminEmail)}</span>
        </div>
        <div class="cb295-checkin-strip-actions">
          <button type="button" class="btn btn-small" id="cb295-admin-edit-profile">Edit my profile</button>
          <button type="button" class="btn btn-small btn-secondary" id="cb295-signout">Sign out</button>
        </div>
      </div>
    `;
  }

  // Signed in + on roster (real student, or admin previewing as student).
  // With daily rotation we show today's group (or the upcoming day's group
  // if before the course week).
  const preallocated = entry;
  const focusDay = bmeDefaultDisplayDay();
  const focusGroup = bmeGetGroupForDay(preallocated, focusDay);
  const todayDay = bmeTodayCourseDay();
  const dayPrefix = focusDay === todayDay ? 'Today\'s group' : `${focusDay}'s group`;
  const groupLabel = focusGroup
    ? `${dayPrefix}: #${esc(String(focusGroup))} · ${esc(preallocated.campus || '—')}`
    : '<em class="muted-text">Groups not yet assigned</em>';

  return `
    <div class="cb295-checkin-strip cb295-checkin-strip-in">
      <div class="cb295-checkin-strip-text">
        <strong>Welcome, ${esc((preallocated.name || '').split(',')[0])}</strong>
        <span class="muted-text">${groupLabel}</span>
      </div>
      <div class="cb295-checkin-strip-actions">
        <button type="button" class="btn" id="cb295-open-bio-modal">Edit your bio and information</button>
        <button type="button" class="btn btn-small btn-secondary" id="cb295-signout">Sign out</button>
      </div>
    </div>
  `;
}

/* ─── Bio-edit modal (opened from the syllabus button) ──────── */
function openBmeBioModal(opts = {}) {
  // V3.261 — `opts` lets admins moderate other users' profiles:
  //   { targetUid, targetEntry, targetName, targetEmail }
  // When unset, the modal targets the signed-in user (existing flow).
  closeBmeBioModal();
  const auth = McgheeLab.Auth;
  if (!auth?.currentUser) return;

  const ownProfile = !opts.targetUid || opts.targetUid === auth.currentUser.uid;
  const targetUid = opts.targetUid || auth.currentUser.uid;
  const targetEntry = opts.targetEntry || (ownProfile ? _bmeRosterEntry : null);
  const targetEmail = (opts.targetEmail || targetEntry?.email || (ownProfile ? auth.currentUser.email : '') || '').toLowerCase();
  const titleText = ownProfile
    ? 'Your BME 295C profile'
    : `Edit ${esc((targetEntry?.name || opts.targetName || 'student').split(',')[0])}'s profile (admin)`;

  // For own-profile, the in-memory `_bmeProfile` is authoritative. For
  // admin-edit-other, prefer the cached target profile; otherwise fall
  // back to an empty shell — we'll populate the textareas asynchronously
  // after a one-shot fetch from `users/{uid}`.
  const cachedTarget = !ownProfile && targetEntry
    ? (_bmeOtherProfileCache.get(targetEntry.id) || null)
    : null;
  const profile = ownProfile
    ? (_bmeProfile || { bio: '', interest: '', photoUrl: '' })
    : (cachedTarget || { bio: '', interest: '', photoUrl: '' });
  const photoSrc = profile.photoUrl || '';

  // For admin-edit-other, the "preallocated" panel shows the target's
  // roster info instead of the current user's.
  const preallocated = targetEntry || {
    name: opts.targetName || auth.currentUser.displayName || '',
    id: '—', pronouns: '—', campus: '—', highSchool: '', groupNumber: null
  };

  const modal = document.createElement('div');
  modal.id = 'cb295-bio-modal';
  modal.className = 'cb295-modal-overlay';
  modal.innerHTML = `
    <div class="cb295-modal" role="dialog" aria-modal="true" aria-labelledby="cb295-modal-title">
      <button type="button" class="cb295-modal-close" id="cb295-modal-close" aria-label="Close">&times;</button>
      <h3 id="cb295-modal-title">${titleText}</h3>

      ${!ownProfile ? '<p class="cb295-admin-note cb295-admin-note-classadmin" style="margin-bottom:.75rem;font-size:.85rem;">Editing as admin — changes go to the student\'s profile. Photo uploads disabled (only the student themselves can upload, per Storage rules).</p>' : ''}

      <div class="cb295-modal-prealloc">
        <div><span class="muted-text">Name</span><strong>${esc(preallocated.name || '—')}</strong></div>
        <div><span class="muted-text">Student ID</span><strong>${esc(preallocated.id || '—')}</strong></div>
        ${preallocated.pronouns ? `<div><span class="muted-text">Pronouns</span><strong>${esc(preallocated.pronouns)}</strong></div>` : ''}
        <div><span class="muted-text">Email</span><strong>${esc(targetEmail || '—')}</strong></div>
        <div><span class="muted-text">High school</span><strong>${preallocated.highSchool ? esc(preallocated.highSchool) : '<em class="muted-text">Unknown</em>'}</strong></div>
        <div class="cb295-modal-prealloc-campus">
          <span class="muted-text">Campus you'll attend from</span>
          ${ownProfile ? `
            <select id="cb295-profile-campus" class="cb295-profile-campus-select">
              <option value="">— pick one —</option>
              <option value="Tucson" ${ (profile.campus || preallocated.campus) === 'Tucson' ? 'selected' : '' }>Tucson</option>
              <option value="Phoenix" ${ (profile.campus || preallocated.campus) === 'Phoenix' ? 'selected' : '' }>Phoenix</option>
            </select>
            <span class="muted-text" style="font-size:.7rem;">Changing campus shifts which group you're in. Your instructor may re-run group assignments before class.</span>
          ` : `<strong>${(profile.campus || preallocated.campus) ? esc(profile.campus || preallocated.campus) : '<em class="muted-text">Unassigned</em>'}</strong>`}
        </div>
        <div class="cb295-modal-prealloc-daily">
          <span class="muted-text">Daily groups</span>
          ${(() => {
            const days = bmeCourseDays();
            const td = bmeTodayCourseDay();
            const any = days.some(d => bmeGetGroupForDay(preallocated, d));
            if (!any) return '<strong><em class="muted-text">Unassigned</em></strong>';
            return `<div class="cb295-daily-chips">${
              days.map(d => {
                const g = bmeGetGroupForDay(preallocated, d);
                const isToday = d === td;
                return `<span class="cb295-daily-chip${isToday ? ' cb295-daily-chip-today' : ''}">
                  <span class="cb295-daily-chip-day">${esc(d.slice(0,3))}</span>
                  <span class="cb295-daily-chip-num">${g ? '#' + esc(String(g)) : '—'}</span>
                </span>`;
              }).join('')
            }</div>`;
          })()}
        </div>
      </div>

      <div class="cb295-modal-body">
        <div class="cb295-profile-photo">
          <div class="cb295-photo-frame" id="cb295-photo-frame">
            ${photoSrc ? `<img src="${esc(photoSrc)}" alt="${esc(preallocated.name)}" />` : '<span class="cb295-photo-placeholder">No photo yet</span>'}
          </div>
          ${ownProfile ? `
            <label class="btn btn-small">
              Upload photo
              <input type="file" id="cb295-photo-input" accept="image/*" style="display:none;" />
            </label>
            <span class="cb295-photo-status muted-text" id="cb295-photo-status"></span>
          ` : ''}
        </div>
        <div class="form-group">
          <label for="cb295-bio">Short bio <span class="muted-text">(optional)</span></label>
          <textarea id="cb295-bio" rows="3" placeholder="A sentence or two about yourself for your group...">${esc(profile.bio || '')}</textarea>
        </div>
        <div class="form-group">
          <label for="cb295-interest">What draws you to biomedical engineering? <span class="muted-text">(optional)</span></label>
          <textarea id="cb295-interest" rows="3" placeholder="What problem in medicine would you most want to work on?">${esc(profile.interest || '')}</textarea>
        </div>
        <p class="cb295-profile-status muted-text" id="cb295-profile-status">Changes save automatically.</p>
      </div>

      <div class="cb295-modal-footer">
        <button type="button" class="btn" id="cb295-modal-done">Done</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  // For admin-edit-other, do a one-shot fetch to populate the textareas
  // with the latest server-side state (the cache could be stale).
  if (!ownProfile && targetUid) {
    McgheeLab.db.collection('users').doc(targetUid).get().then(doc => {
      const fresh = doc.data()?.bme295c || null;
      if (!fresh) return;
      const bioEl = document.getElementById('cb295-bio');
      const interestEl = document.getElementById('cb295-interest');
      const frame = document.getElementById('cb295-photo-frame');
      if (bioEl && !bioEl.dataset.dirty) bioEl.value = fresh.bio || '';
      if (interestEl && !interestEl.dataset.dirty) interestEl.value = fresh.interest || '';
      if (frame && fresh.photoUrl && !frame.innerHTML.includes('<img')) {
        frame.innerHTML = `<img src="${esc(fresh.photoUrl)}" alt="${esc(preallocated.name)}" />`;
      }
      // Refresh the cache with the latest server data + uid for downstream readers.
      if (targetEntry) _bmeOtherProfileCache.set(targetEntry.id, { ...fresh, _uid: targetUid });
    }).catch(() => { /* the editable inputs already show cached or empty values */ });
  }

  // Wire modal interactions
  const close = () => closeBmeBioModal();
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  document.getElementById('cb295-modal-close')?.addEventListener('click', close);
  document.getElementById('cb295-modal-done')?.addEventListener('click', close);

  // Reuse the existing save logic — bio + interest autosave, photo upload
  const bio = document.getElementById('cb295-bio');
  const interest = document.getElementById('cb295-interest');
  const status = document.getElementById('cb295-profile-status');
  const scheduleSave = (ev) => {
    if (ev?.target) ev.target.dataset.dirty = '1';
    if (status) status.textContent = 'Saving…';
    clearTimeout(_bmeProfileSaveTimer);
    _bmeProfileSaveTimer = setTimeout(() => saveBmeProfile({ targetUid, targetEntry, ownProfile }), 600);
  };
  bio?.addEventListener('input', scheduleSave);
  interest?.addEventListener('input', scheduleSave);
  // V3.271 — campus selector for own profile only (admins editing
  // someone else's profile can't change their campus).
  if (ownProfile) {
    document.getElementById('cb295-profile-campus')?.addEventListener('change', scheduleSave);
    document.getElementById('cb295-photo-input')?.addEventListener('change', uploadBmeProfilePhoto);
  }

  // ESC key closes
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  modal.dataset.escHandler = '1';
  modal._escHandler = onKey;
}

function closeBmeBioModal() {
  const modal = document.getElementById('cb295-bio-modal');
  if (!modal) return;
  if (modal._escHandler) document.removeEventListener('keydown', modal._escHandler);
  modal.remove();
}

/* ─── Standalone enrollment page (#/classes/bme295c/enroll) ─── */
function renderClassEnrollPage(classId) {
  if (classId !== 'bme295c') return null;
  return `
    <div class="cb295-enroll max-w" data-class-id="${esc(classId)}">
      <a href="#/classes/bme295c" class="cb295-enroll-back">&larr; Back to syllabus</a>
      <div class="cb295-enroll-card" id="cb295-enroll-card">
        <p class="muted-text" style="text-align:center;">Loading…</p>
      </div>
    </div>
  `;
}

async function wireClassEnrollPage(classId) {
  if (classId !== 'bme295c') return;
  const card = document.getElementById('cb295-enroll-card');
  if (!card) return;

  // Load roster from Firestore (or fall back to default seed)
  let schedule = null;
  try { schedule = await ScheduleDB.getSchedule(classId); } catch (e) {}
  if (!schedule) schedule = DEFAULT_SCHEDULES[classId];
  const roster = Array.isArray(schedule?.studentRoster) ? schedule.studentRoster : [];

  const auth = McgheeLab.Auth;
  const renderState = () => {
    const signedIn = !!auth?.currentUser;
    const email = signedIn ? (auth.currentUser.email || '').toLowerCase() : '';
    const entry = signedIn && email ? roster.find(r => (r.email || '').toLowerCase() === email) : null;

    if (!signedIn) {
      card.innerHTML = `
        <h2>Welcome to BME 295C</h2>
        <p>Sign in with the email you used to register for the course. Once you're in, you can edit your bio and see your discussion-group assignment for each session.</p>
        <button type="button" class="btn cb295-enroll-cta" id="cb295-enroll-signin">Sign in with Google</button>
        <p class="muted-text" style="font-size:.85rem;margin-top:1rem;">Having trouble? Email <a href="mailto:mcgheealex@gmail.com">mcgheealex@gmail.com</a>.</p>
      `;
      document.getElementById('cb295-enroll-signin')?.addEventListener('click', async () => {
        try { await McgheeLab.Auth.googleLogin(); renderState(); }
        catch (e) { alert('Sign-in failed: ' + (e.message || e)); }
      });
      return;
    }

    if (entry) {
      const days = bmeCourseDays();
      const anyGroup = days.some(d => bmeGetGroupForDay(entry, d));
      const todayDay = bmeTodayCourseDay();
      const focusDay = bmeDefaultDisplayDay();
      const focusGroup = bmeGetGroupForDay(entry, focusDay);
      const groupLine = anyGroup
        ? `<p>${
            focusGroup
              ? (todayDay === focusDay
                  ? `Today (${esc(focusDay)}) you're in <strong>Group #${esc(String(focusGroup))}</strong> on the <strong>${esc(entry.campus || '—')}</strong> campus.`
                  : `On ${esc(focusDay)} (the first session) you're in <strong>Group #${esc(String(focusGroup))}</strong> on the <strong>${esc(entry.campus || '—')}</strong> campus.`)
              : `Your groups are set — see the course page for today's number.`
          }</p>
          <p class="muted-text" style="font-size:.85rem;">Groups rotate each day so you meet different classmates. ${
            days.map(d => `<span style="white-space:nowrap;">${esc(d.slice(0,3))} #${
              bmeGetGroupForDay(entry, d) ? esc(String(bmeGetGroupForDay(entry, d))) : '—'
            }</span>`).join(' · ')
          }</p>`
        : `<p class="muted-text">Your groups haven't been assigned yet — check back closer to June 8.</p>`;
      card.innerHTML = `
        <h2>You're enrolled, ${esc((entry.name || '').split(',')[0])}</h2>
        ${groupLine}
        <a href="#/classes/bme295c" class="btn cb295-enroll-cta">Go to the course page</a>
        <button type="button" class="btn btn-small btn-secondary" id="cb295-enroll-signout" style="margin-top:.5rem;">Sign out</button>
      `;
    } else {
      card.innerHTML = `
        <h2>Your email isn't on the roster</h2>
        <p>You're signed in as <strong>${esc(auth.currentUser.email)}</strong>, but that address isn't on the BME 295C roster. If you registered with a different email, sign out and sign back in with that one.</p>
        <p class="muted-text">If you think this is a mistake, email <a href="mailto:mcgheealex@gmail.com">mcgheealex@gmail.com</a>.</p>
        <button type="button" class="btn cb295-enroll-cta" id="cb295-enroll-signout">Sign out</button>
      `;
    }
    document.getElementById('cb295-enroll-signout')?.addEventListener('click', async () => {
      try { await McgheeLab.auth.signOut(); renderState(); } catch (e) {}
    });
  };

  renderState();
}

/* ─── Tab 1: Syllabus section body ───────────────────────────── */
function renderBmeSyllabusBody() {
  if (!_bmeContent) return '<p class="muted-text">Loading course information…</p>';
  const c = _bmeContent;
  const course = c.course || {};
  const locs = c.locations || [];
  const instructors = bmeGetInstructors();
  const policies = c.policies || {};

  const locCards = locs.map(l => {
    const links = [];
    if (l.mapUrl) links.push(`<a href="${esc(l.mapUrl)}" target="_blank" rel="noopener" class="cb295-loc-link cb295-loc-link-map">${ICON.svg('map-pin')} Open in Google Maps</a>`);
    // V3.275 — `parkingOptions: [{ label, url }, ...]` supersedes the
    // single `parkingUrl`. Both fields can coexist on a location; the
    // array wins when present. Falls back to `parkingUrl` for any
    // location entry that hasn't been migrated.
    if (Array.isArray(l.parkingOptions) && l.parkingOptions.length) {
      l.parkingOptions.forEach(opt => {
        if (opt?.url) links.push(`<a href="${esc(opt.url)}" target="_blank" rel="noopener" class="cb295-loc-link cb295-loc-link-parking">${ICON.svg('square-parking')} ${esc(opt.label || 'Parking')}</a>`);
      });
    } else if (l.parkingUrl) {
      links.push(`<a href="${esc(l.parkingUrl)}" target="_blank" rel="noopener" class="cb295-loc-link cb295-loc-link-parking">${ICON.svg('square-parking')} Parking info</a>`);
    }
    if (l.parkingMap) links.push(`<a href="${bmeAssetUrl(l.parkingMap)}" target="_blank" rel="noopener" class="cb295-loc-link cb295-loc-link-parking">${ICON.svg('square-parking')} Parking map (PDF)</a>`);
    return `
      <div class="cb295-loc-card">
        <h4>${esc(l.campus)}</h4>
        <p class="cb295-loc-building">${esc(l.building)}, Room <strong>${esc(l.room)}</strong></p>
        <p class="muted-text" style="font-size:.85rem;">${esc(l.fullName)}</p>
        ${l.roomNote ? `<p class="cb295-loc-roomnote" style="font-size:.85rem;background:#fff7d6;border-left:3px solid #d4a017;padding:.5rem .65rem;border-radius:4px;margin:.5rem 0;color:#5a4500;"><strong>Room change:</strong> ${esc(l.roomNote)}</p>` : ''}
        ${links.length ? `<div class="cb295-loc-links">${links.join('')}</div>` : ''}
        ${l.parkingNote ? `<p class="cb295-loc-parkingnote muted-text">${esc(l.parkingNote)}</p>` : ''}
      </div>
    `;
  }).join('');

  // V3.266 — photo + bio on the syllabus instructor cards.
  const instructorCards = instructors.map(i => {
    const initial = ((i.name || '?').replace(/^(Dr\.|Prof\.|Mr\.|Ms\.|Mrs\.)\s+/i, '').charAt(0) || '?').toUpperCase();
    const photoBlock = i.photoUrl
      ? `<img class="cb295-instructor-card-photo" src="${esc(i.photoUrl)}" alt="${esc(i.name || '')}" loading="lazy" />`
      : `<div class="cb295-instructor-card-photo cb295-instructor-card-photo-blank">${esc(initial)}</div>`;
    return `
      <div class="cb295-instructor-card">
        ${photoBlock}
        <h4>${esc(i.name)}</h4>
        <p class="cb295-instructor-role muted-text">${esc(i.role)}</p>
        <p style="font-size:.85rem;">${esc(i.department)}</p>
        <p style="font-size:.85rem;">${esc(i.office)}</p>
        <p style="font-size:.85rem;"><a href="mailto:${esc(i.email)}">${esc(i.email)}</a></p>
        ${i.bio ? `<p class="cb295-instructor-bio-text" style="font-size:.85rem;">${esc(i.bio).replace(/\n/g, '<br>')}</p>` : ''}
      </div>
    `;
  }).join('');

  // V3.264 — billing notice. Drawn at the top of the syllabus when
  // `content.feeNotice` is present so students see it before any
  // tuition / textbook charge confusion. Hidden when the field is
  // unset, so removing the block from content.json removes the call-
  // out without code changes.
  const fee = c.feeNotice;
  const feeNoticeHtml = fee ? `
    <section class="cb295-fee-notice">
      <div class="cb295-fee-notice-header">
        <span class="cb295-fee-notice-icon" aria-hidden="true">${ICON.svg('exclamation-triangle')}</span>
        <strong>${esc(fee.title || 'Important billing notice')}</strong>
      </div>
      ${fee.body ? `<p>${esc(fee.body)}</p>` : ''}
      ${Array.isArray(fee.steps) && fee.steps.length ? `
        <ol class="cb295-fee-notice-steps">
          ${fee.steps.map(s => {
            if (typeof s === 'object' && s.label && s.href) {
              return `<li><a href="${esc(s.href)}" target="_blank" rel="noopener">${esc(s.label)}</a></li>`;
            }
            return `<li>${esc(typeof s === 'string' ? s : (s.label || ''))}</li>`;
          }).join('')}
        </ol>
      ` : ''}
    </section>
  ` : '';

  return `
    <div class="cb295-syllabus">
      ${feeNoticeHtml}
      <section class="cb295-syl-overview">
        <p>${esc(course.description || '')}</p>
        <div class="cb295-syl-keyfacts">
          <div><span class="muted-text">Dates</span><strong>${esc(course.dates || '')}</strong></div>
          <div><span class="muted-text">Duration</span><strong>${esc(course.duration || '')}</strong></div>
          <div><span class="muted-text">Times</span><strong>${esc(course.times || '')}</strong></div>
          <div><span class="muted-text">Prerequisites</span><strong>${esc(course.prerequisites || 'None')}</strong></div>
        </div>
      </section>

      <section>
        <h3>Where to arrive</h3>
        <div class="cb295-loc-grid">${locCards}</div>
      </section>

      <section>
        <h3>Instructors &amp; advisor</h3>
        <div class="cb295-instructor-grid">${instructorCards}</div>
      </section>

      <section>
        <h3>Course objectives</h3>
        <ul class="cb295-bullet-list">
          ${(c.objectives || []).map(o => `<li>${esc(o)}</li>`).join('')}
        </ul>
      </section>

      <section>
        <h3>What to bring</h3>
        <ul class="cb295-bullet-list">
          ${(c.materials || []).map(m => `<li>${esc(m)}</li>`).join('')}
        </ul>
      </section>

      <section>
        <h3>Policies</h3>
        <details class="cb295-policy"><summary>Grading</summary>${bmePara(policies.grading)}</details>
        <details class="cb295-policy"><summary>Attendance</summary>${bmePara(policies.attendance)}</details>
        <details class="cb295-policy"><summary>Class recordings</summary>${bmePara(policies.recordings)}</details>
        <details class="cb295-policy"><summary>Classroom behavior</summary>${bmePara(policies.behavior)}</details>
      </section>
    </div>
  `;
}

/* ─── Tab 2: Speaker schedule section body ──────────────────── */
function renderBmeScheduleBody() {
  if (!_bmeContent) return '<p class="muted-text">Loading schedule…</p>';
  const c = _bmeContent;
  const speakers = c.speakers || [];
  const schedule = c.schedule || [];
  const locs = c.locations || [];

  // V3.262 — quick-access location bar at the top of the schedule.
  // Each campus gets a compact card with prominent Map / Parking buttons
  // so students don't have to flip back to the syllabus tab the morning
  // of a session.
  const locBarCards = locs.map(l => {
    const links = [];
    if (l.mapUrl) links.push(`<a href="${esc(l.mapUrl)}" target="_blank" rel="noopener" class="cb295-loc-link cb295-loc-link-map">${ICON.svg('map-pin')} Map</a>`);
    // V3.275 — match the syllabus card behavior: iterate parkingOptions
    // when present, otherwise fall back to the legacy single parkingUrl.
    // Compact button uses just the option label; the syllabus card has
    // the longer "Parking info" copy.
    if (Array.isArray(l.parkingOptions) && l.parkingOptions.length) {
      l.parkingOptions.forEach(opt => {
        if (opt?.url) links.push(`<a href="${esc(opt.url)}" target="_blank" rel="noopener" class="cb295-loc-link cb295-loc-link-parking">${ICON.svg('square-parking')} ${esc(opt.label || 'Parking')}</a>`);
      });
    } else if (l.parkingUrl) {
      links.push(`<a href="${esc(l.parkingUrl)}" target="_blank" rel="noopener" class="cb295-loc-link cb295-loc-link-parking">${ICON.svg('square-parking')} Parking</a>`);
    }
    if (l.parkingMap) links.push(`<a href="${bmeAssetUrl(l.parkingMap)}" target="_blank" rel="noopener" class="cb295-loc-link cb295-loc-link-parking">${ICON.svg('square-parking')} PDF</a>`);
    return `
      <div class="cb295-locbar-card">
        <div class="cb295-locbar-text">
          <strong>${esc(l.campus)}</strong>
          <span class="muted-text">${esc(l.building)} · Room ${esc(l.room)}</span>
          ${l.parkingNote ? `<span class="muted-text cb295-locbar-parkingnote">${esc(l.parkingNote)}</span>` : ''}
        </div>
        ${links.length ? `<div class="cb295-locbar-links">${links.join('')}</div>` : ''}
      </div>
    `;
  }).join('');
  const locBar = locs.length
    ? `<section class="cb295-locbar"><div class="cb295-locbar-grid">${locBarCards}</div></section>`
    : '';

  // Build day grid
  const dayCards = schedule.map(day => `
    <div class="cb295-day-card">
      <div class="cb295-day-header">
        <strong>${esc(day.day)}</strong>
        <span class="muted-text">${esc(day.date)}</span>
      </div>
      <ul class="cb295-day-list">
        ${(day.sessions || []).map(s => `
          <li class="cb295-day-row cb295-day-row-${esc(s.type)}">
            <span class="cb295-day-time">${esc(s.time)}</span>
            <span class="cb295-day-topic">${esc(s.topic)}</span>
            <span class="cb295-day-campus muted-text">${esc(s.campus)}</span>
          </li>
        `).join('')}
      </ul>
    </div>
  `).join('');

  // Speaker lineup — photo + abstract grid
  const speakerCards = speakers.map(sp => `
    <article class="cb295-speaker-card">
      <div class="cb295-speaker-photo">
        <img src="${bmeAssetUrl(sp.photo)}" alt="${esc(sp.name)}" loading="lazy" />
      </div>
      <div class="cb295-speaker-body">
        <header>
          <h3>${esc(sp.name)}</h3>
          <p class="cb295-speaker-title muted-text">${esc(sp.title)}</p>
          <p class="cb295-speaker-meta">
            <span class="cb295-tag">${esc(sp.day)}</span>
            <span class="cb295-tag">${esc(sp.time)}</span>
            <span class="cb295-tag cb295-tag-campus">${esc(sp.campus)}</span>
          </p>
        </header>
        <h4 class="cb295-talk-title">${esc(sp.talkTitle)}</h4>
        <details class="cb295-abstract">
          <summary>Read abstract</summary>
          ${bmePara(sp.abstract)}
        </details>
        <p class="cb295-labtour muted-text">
          <strong>Lab tour:</strong> ${esc(sp.labTour)}
        </p>
      </div>
    </article>
  `).join('');

  return `
    <div class="cb295-schedule">
      ${locBar}
      <section>
        <h3>Daily schedule</h3>
        <p class="muted-text">Lectures are joined live from both campuses. Lab tours are campus-specific.</p>
        <div class="cb295-day-grid">${dayCards}</div>
      </section>
      <section>
        <h3>Speaker lineup</h3>
        <div class="cb295-speaker-grid">${speakerCards}</div>
      </section>
    </div>
  `;
}

/* ─── Tab 3: Discussion modules section body ────────────────── */
function renderBmeModulesBody() {
  if (!_bmeContent) return '<p class="muted-text">Loading discussion modules…</p>';
  const c = _bmeContent;
  const speakers = c.speakers || [];
  const discussion = c.discussion || {};
  const auth = McgheeLab.Auth;
  const signedIn = !!auth?.currentUser;

  // Group banner at top — single source of truth for who's in the group + confirm UI.
  const banner = buildBmeGroupBanner(signedIn);

  // How-it-works hint above the cards
  const intro = `
    <div class="cb295-modules-intro muted-text">
      Each speaker has discussion prompts your group works through together after the talk.
      Pick a topic, do a little online research, and submit a <strong>~100-word response per group</strong> in the box at the bottom of each card.
    </div>
  `;

  // V3.269 — first pending speaker gets an "Up next" focus.
  const nextUpSlug = bmeNextPendingSpeakerSlug();

  const cards = speakers.map(sp => {
    const points = discussion[sp.slug] || [];
    const entry = _bmeRosterEntry;
    const day = bmeSpeakerDay(sp.slug);
    const dayGroup = bmeGetGroupForDay(entry, day);
    // V3.269 — same gate state as `buildBmeResponseShell`. `canEdit` here
    // controls per-prompt textarea vs read-only display.
    const gateState = bmeGetDiscussionState(sp.slug);
    const canEdit = !!(signedIn && entry && dayGroup && entry.campus) && gateState === 'open';
    const response = _bmeGroupResponses?.get(sp.slug) || null;
    const promptVals = response?.prompts || { 0: '', 1: '', 2: '' };

    // V3.253 — each <li> is one discussion point. The textarea + word
    // count sit directly beneath the prompt + Dig-deeper, so editing
    // happens in context. The wrapping response shell (banner + footer
    // with submit button + status) lives below the <ol>.
    const pointsHtml = points.map((p, idx) => {
      const val = promptVals[idx] || '';
      const wc = countWords(val);
      let inputBlock = '';
      if (canEdit) {
        inputBlock = `
          <div class="cb295-discussion-input">
            <textarea id="cb295-resp-${esc(sp.slug)}-${idx}"
                      class="cb295-response-text-input"
                      data-speaker-slug="${esc(sp.slug)}"
                      data-prompt-idx="${idx}"
                      rows="3"
                      placeholder="Group response to prompt ${idx + 1}…">${esc(val)}</textarea>
            <span class="cb295-response-wordcount-per"
                  data-speaker-slug="${esc(sp.slug)}"
                  data-prompt-idx="${idx}">${wc} word${wc === 1 ? '' : 's'}</span>
          </div>
        `;
      } else if (val.trim()) {
        // Read-only view (signed-out / non-group viewer / locked /
        // pending) — show the saved response for this prompt inline.
        // V3.269 — when the gate is locked, paint the inline block in
        // the same muted style as the response footer so it's clearly
        // "frozen" not "I-could-edit-but-haven't".
        const lockedCls = gateState === 'locked' ? ' cb295-discussion-input-locked' : '';
        inputBlock = `
          <div class="cb295-discussion-input cb295-discussion-input-readonly${lockedCls}">
            <div class="cb295-response-text">${esc(val).replace(/\n/g, '<br>')}</div>
          </div>
        `;
      }
      return `
        <li class="cb295-discussion-item">
          <p class="cb295-discussion-prompt"><span class="cb295-discussion-num">${idx + 1}</span>${esc(p.prompt)}</p>
          ${(p.followups && p.followups.length) ? `
            <details class="cb295-discussion-dig">
              <summary>Dig deeper</summary>
              <ul>${p.followups.map(f => `<li>${esc(f)}</li>`).join('')}</ul>
            </details>` : ''}
          ${inputBlock}
        </li>
      `;
    }).join('');

    const responseShell = buildBmeResponseShell(sp, signedIn);

    // V3.269 — card-level state classes drive the visual treatment:
    // pending → muted border, open → default, locked → 50% opacity,
    // next-up → blue accent + "Up next" badge in the summary.
    const isNextUp = sp.slug === nextUpSlug;
    const cardCls = [
      'cb295-mod-card',
      `cb295-mod-card-state-${gateState}`,
      gateState === 'locked' ? 'cb295-mod-card-locked' : '',
      isNextUp ? 'cb295-mod-card-next-up' : ''
    ].filter(Boolean).join(' ');
    const nextUpBadge = isNextUp
      ? '<span class="cb295-mod-card-nextup-badge" title="Instructor will release this discussion next">Up next</span>'
      : (gateState === 'open'
          ? '<span class="cb295-mod-card-open-badge" title="Discussion is open for editing">Open</span>'
          : (gateState === 'locked'
              ? '<span class="cb295-mod-card-locked-badge" title="Discussion is closed">Closed</span>'
              : ''));

    // V3.272 — talk recording, when the admin has set a YouTube URL/id
    // for this speaker. iframe is lazy-loaded so the modules tab doesn't
    // pull 10 YouTube embeds on initial paint — they kick in only when
    // a student expands the <details> card. Block is omitted entirely
    // when no video is set (no empty placeholder).
    const videoId = bmeGetSpeakerVideoId(sp.slug);
    const videoBlock = videoId
      ? `<div class="cb295-mod-video">
           <iframe src="https://www.youtube.com/embed/${esc(videoId)}?rel=0&modestbranding=1"
                   title="Talk recording — ${escAttr(sp.name.split(',')[0])}"
                   allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                   loading="lazy"
                   allowfullscreen></iframe>
         </div>`
      : '';

    // V3.282 — hide discussion prompts + response shell from students
    // until admin opens the gate. Admin viewers always see the prompts
    // (so they can review content while the talk is still pending);
    // class-admins ditto. Students see only the abstract + a callout
    // explaining the discussion will be released. Locked state still
    // shows everything (read-only) so students can see what their
    // group submitted.
    const adminPreview = _viewType === 'admin';
    const hidePrompts = gateState === 'pending' && !adminPreview;
    const discussionBlock = hidePrompts
      ? `<p class="cb295-mod-pending-callout">
           <span aria-hidden="true">${ICON.svg('clock')}</span>
           <strong>Discussion not yet open.</strong>
           Your instructor will release the prompts + the response box after the talk.
         </p>`
      : `<h4>Discussion prompts${adminPreview && gateState === 'pending' ? ' <span class="cb295-mod-pending-preview-tag">admin preview — pending</span>' : ''}</h4>
         ${points.length ? `<ol class="cb295-discussion-list">${pointsHtml}</ol>` : '<p class="muted-text">Prompts forthcoming.</p>'}
         ${responseShell}`;

    return `
      <details class="${cardCls}" data-speaker-slug="${esc(sp.slug)}" data-discussion-state="${esc(gateState)}"${gateState === 'open' ? ' open' : ''}>
        <summary class="cb295-mod-summary">
          <img class="cb295-mod-photo" src="${bmeAssetUrl(sp.photo)}" alt="" loading="lazy" />
          <div class="cb295-mod-summary-body">
            <strong>${esc(sp.name.split(',')[0])}${nextUpBadge}</strong>
            <span class="muted-text">${esc(sp.day)} · ${esc(sp.time)} · ${esc(sp.campus)}</span>
            <span class="cb295-mod-talk">${esc(sp.talkTitle)}</span>
          </div>
        </summary>
        <div class="cb295-mod-body">
          ${videoBlock}
          <p class="cb295-mod-abstract muted-text">${esc(sp.abstract.slice(0, 280))}${sp.abstract.length > 280 ? '…' : ''}</p>
          ${discussionBlock}
        </div>
      </details>
    `;
  }).join('');

  return `<div class="cb295-modules">${banner}${intro}${cards}</div>`;
}

/** Group banner shown once at the top of the modules tab.
 * Daily-rotation aware: shows today's group + mates by default, with a
 * 5-day strip the student can click to peek at any other day's group.
 */
function buildBmeGroupBanner(signedIn) {
  if (!signedIn) {
    return `<div class="cb295-group-banner cb295-group-banner-empty">
      <strong>Sign in to see your discussion group.</strong>
      <a href="#/classes/bme295c/enroll" class="btn btn-small" style="margin-left:.5rem;">Login</a>
    </div>`;
  }
  const entry = _bmeRosterEntry;
  if (!entry) {
    return `<div class="cb295-group-banner cb295-group-banner-empty">
      You're signed in but not on the BME 295C roster — group submissions are limited to enrolled students.
    </div>`;
  }
  const days = bmeCourseDays();
  const hasAnyGroup = days.some(d => bmeGetGroupForDay(entry, d));
  if (!entry.campus || !hasAnyGroup) {
    return `<div class="cb295-group-banner cb295-group-banner-empty">
      Your groups haven't been assigned yet — check back closer to <strong>June 8</strong>.
    </div>`;
  }

  const focusDay = (_bmeBannerFocusDay && days.includes(_bmeBannerFocusDay))
    ? _bmeBannerFocusDay
    : bmeDefaultDisplayDay();
  const focusGroup = bmeGetGroupForDay(entry, focusDay);
  const mates = bmeMatesForDay(entry, focusDay);

  // Include the current user as the first mate so the group view shows everyone
  const selfMate = {
    name: entry.name, id: entry.id, email: entry.email, isSelf: true
  };
  const allMates = [selfMate, ...mates];

  const mateHtml = focusGroup ? allMates.map(gm => {
    const prof = gm.isSelf
      ? (_bmeProfile || null)
      : (gm.email ? (_bmeGroupProfiles?.get(gm.email.toLowerCase()) || null) : null);
    const photo = prof?.photoUrl || '';
    const interest = prof?.interest || '';
    const displayName = (gm.name || '').split(',')[0];
    return `
      <div class="cb295-mate${gm.isSelf ? ' cb295-mate-self' : ''}">
        ${photo
          ? `<img class="cb295-mate-photo" src="${esc(photo)}" alt="" loading="lazy" />`
          : `<div class="cb295-mate-photo cb295-mate-photo-blank">${esc((displayName || '?').charAt(0))}</div>`}
        <div class="cb295-mate-name">
          <strong>${esc(displayName)}${gm.isSelf ? ' <span class="cb295-mate-you">(you)</span>' : ''}</strong>
          ${interest ? `<span class="muted-text cb295-mate-interest">${esc(interest.slice(0, 80))}${interest.length > 80 ? '…' : ''}</span>` : ''}
        </div>
      </div>
    `;
  }).join('') : '<p class="muted-text">No group on this day.</p>';

  const todayDay = bmeTodayCourseDay();
  const strip = days.map(d => {
    const g = bmeGetGroupForDay(entry, d);
    const isFocus = d === focusDay;
    const isToday = d === todayDay;
    const dayShort = d.slice(0, 3);
    return `
      <button type="button"
              class="cb295-rotation-chip${isFocus ? ' cb295-rotation-chip-focus' : ''}${isToday ? ' cb295-rotation-chip-today' : ''}"
              data-day="${esc(d)}">
        <span class="cb295-rotation-chip-day">${esc(dayShort)}${isToday ? ' (today)' : ''}</span>
        <span class="cb295-rotation-chip-group">${g ? '#' + esc(String(g)) : '—'}</span>
      </button>
    `;
  }).join('');

  const effectiveCampus = bmeEffectiveCampus(entry, _bmeProfile);
  const headerSub = todayDay
    ? `${esc(effectiveCampus || entry.campus || '')} campus · groups change each day`
    : `${esc(effectiveCampus || entry.campus || '')} campus · groups rotate Mon–Fri`;

  const focusLabel = focusGroup
    ? `Group #${esc(String(focusGroup))}`
    : 'No group';
  const focusContext = todayDay === focusDay
    ? `today (${esc(focusDay)})`
    : esc(focusDay);

  return `
    <div class="cb295-group-banner cb295-group-banner-daily" data-focus-day="${esc(focusDay)}">
      <div class="cb295-group-banner-header">
        <div>
          <strong class="cb295-group-banner-focus-label">${focusLabel}</strong>
          <span class="muted-text cb295-group-banner-focus-context"> · ${focusContext}</span>
          <div class="muted-text" style="font-size:.8rem;">${headerSub}</div>
        </div>
      </div>
      <div class="cb295-rotation-strip">${strip}</div>
      <div class="cb295-mate-grid">${mateHtml}</div>
      <p class="cb295-group-banner-foot muted-text">
        Something off?
        <button type="button" class="cb295-link-btn" id="cb295-goto-chat">Send Chat to instructor</button>.
      </p>
    </div>
  `;
}

/** Per-speaker group response box rendered below the discussion prompts.
 * The doc ID uses the user's group number for THIS speaker's day, so
 * Monday's group #2 and Tuesday's group #2 (which are different sets
 * of students under daily rotation) keep separate response docs.
 */
/** V3.253 — response shell. Renders the banner + footer (submit, total
 * word count, status) for a speaker's group response. The actual per-
 * prompt textareas are rendered inline next to each prompt in the
 * discussion list (renderBmeModulesBody) — that change put each edit
 * box right under its discussion point.
 *
 * Read-only viewers (signed-out / non-group) see either a "not yet
 * submitted" muted note (when no content exists) or just the metadata
 * footer (when the prompts already rendered the saved text inline).
 */
function buildBmeResponseShell(speaker, signedIn) {
  const entry = _bmeRosterEntry;
  const day = bmeSpeakerDay(speaker.slug);
  const dayGroup = bmeGetGroupForDay(entry, day);
  // V3.269 — admin's discussion gate is the additional gate on top of
  // the roster/group eligibility. State machine: pending (default) →
  // open → locked. Only `open` allows edits.
  const gateState = bmeGetDiscussionState(speaker.slug);
  const eligibleToEdit = !!(signedIn && entry && dayGroup && entry.campus);
  const canEdit = eligibleToEdit && gateState === 'open';
  const response = _bmeGroupResponses?.get(speaker.slug) || null;
  const prompts = response?.prompts || { 0: '', 1: '', 2: '' };
  const status = response?.status || 'draft';
  const lastEdited = response?.lastEditedName ? `Last edited by ${esc(response.lastEditedName)}` : '';
  const lastEditedTime = response?.lastEditedAt?.toDate
    ? response.lastEditedAt.toDate().toLocaleString('en-US', { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' })
    : '';
  const totalWords =
    countWords(prompts[0] || '') +
    countWords(prompts[1] || '') +
    countWords(prompts[2] || '');

  if (!canEdit) {
    const anyContent = ((prompts[0] || '') + (prompts[1] || '') + (prompts[2] || '')).trim();
    // V3.285 — when a signed-in roster student has a campus but no
    // group for this speaker's day (dailyGroups[day] missing after the
    // groupNumber-fallback removal), the legacy code rendered the
    // generic "sign in to participate" fallback below — which was
    // wrong because they ARE signed in, the admin just hasn't run
    // auto-assign for this day. Surface that explicitly so the
    // student knows whose fault it is.
    if (signedIn && entry && entry.campus && !dayGroup) {
      return `
        <div class="cb295-response cb295-response-readonly cb295-response-no-group" data-speaker-slug="${esc(speaker.slug)}">
          <p class="cb295-response-no-group-strip">
            <span aria-hidden="true">${ICON.svg('users')}</span>
            <strong>Your group for ${esc(day || 'this day')} hasn't been assigned yet.</strong>
            Ask your instructor to run group assignment so you can participate.
          </p>
        </div>
      `;
    }
    // V3.269 — branch by gate state for eligible viewers so they get
    // a clear "why can't I edit?" cue. Non-eligible viewers fall
    // through to the legacy "sign in" message.
    if (eligibleToEdit && gateState === 'pending') {
      return `
        <div class="cb295-response cb295-response-readonly cb295-response-pending" data-speaker-slug="${esc(speaker.slug)}">
          <p class="cb295-response-pending-strip">
            <span aria-hidden="true">${ICON.svg('clock')}</span>
            <strong>Discussion not yet open.</strong>
            Your instructor will release this after the talk.
          </p>
        </div>
      `;
    }
    if (eligibleToEdit && gateState === 'locked') {
      return `
        <div class="cb295-response cb295-response-readonly cb295-response-locked" data-speaker-slug="${esc(speaker.slug)}">
          <p class="cb295-response-locked-strip">
            <span aria-hidden="true">${ICON.svg('lock-closed')}</span>
            <strong>Discussion closed.</strong>
            Your group's response is locked.
          </p>
          ${anyContent
            ? `<p class="muted-text cb295-response-meta">${esc(status === 'submitted' ? 'Submitted' : 'Draft')}${lastEdited ? ' · ' + lastEdited : ''}${lastEditedTime ? ' · ' + lastEditedTime : ''} · ${totalWords} word${totalWords === 1 ? '' : 's'} total</p>`
            : ''
          }
        </div>
      `;
    }
    return `
      <div class="cb295-response cb295-response-readonly" data-speaker-slug="${esc(speaker.slug)}">
        ${anyContent
          ? `<p class="muted-text cb295-response-meta">${esc(status === 'submitted' ? 'Submitted' : 'Draft')}${lastEdited ? ' · ' + lastEdited : ''}${lastEditedTime ? ' · ' + lastEditedTime : ''} · ${totalWords} word${totalWords === 1 ? '' : 's'} total</p>`
          : `<p class="muted-text">No response yet. Sign in as a member of this group to write one.</p>`
        }
      </div>
    `;
  }

  const submitted = status === 'submitted';
  const banner = `
    <p class="cb295-response-banner">
      <strong>Pick one writer per group</strong> — this submission will be assigned to all students in this group.${
        lastEdited
          ? ` <span class="muted-text">Currently editing: <strong>${esc(response?.lastEditedName || '')}</strong>${lastEditedTime ? ' · ' + esc(lastEditedTime) : ''}.</span>`
          : ''
      }
    </p>
  `;

  return `
    <div class="cb295-response${submitted ? ' cb295-response-submitted' : ''}" data-speaker-slug="${esc(speaker.slug)}">
      ${banner}
      <div class="cb295-response-footer">
        <span class="cb295-response-wordcount" data-speaker-slug="${esc(speaker.slug)}">${totalWords} word${totalWords === 1 ? '' : 's'} total</span>
        <span class="cb295-response-status muted-text" data-speaker-slug="${esc(speaker.slug)}">${lastEdited ? lastEdited + (lastEditedTime ? ' · ' + lastEditedTime : '') : 'Not saved yet'}</span>
        <button type="button" class="btn btn-small cb295-response-submit" data-speaker-slug="${esc(speaker.slug)}">
          ${submitted ? '&#10003; Submitted — Unlock to edit' : 'Submit response'}
        </button>
      </div>
    </div>
  `;
}

function countWords(s) {
  if (!s || !s.trim()) return 0;
  return s.trim().split(/\s+/).length;
}

/* ─── Tab 3 (admin only): Roster editor — moved to Admin Dashboard tab in V3.249.
 * Section kept registered so legacy schedule docs that still list
 * `roster295c` render a redirect instead of an empty pane. The V3.249
 * migration in wireClassPage strips this section from `tabs[].sections`.
 */
function renderBmeRosterBody(editing) {
  if (_viewType !== 'admin') return '';
  return `<p class="muted-text" style="padding:1rem 0;">
    Roster + class admin management moved to the <strong>Admin Dashboard</strong> tab in V3.249.
    Switch to that tab using the bar above.
  </p>`;
}

/* ─── Course Assessment Section (V3.286) ───────────────────────
 * End-of-course feedback form. One doc per student keyed by uid at
 * schedules/bme295c/assessments/{auth.uid}. Gated by
 * _classData.assessmentState ('closed' → 'open' → 'locked'); admin
 * flips the gate from the dashboard. Anonymity is honor-system:
 * a per-submission checkbox sets payload.anonymous, but the docId is
 * still the uid so the student can edit their own draft, and
 * lastEditedName is stored so admin can resolve in DevTools if needed.
 * Save path mirrors V3.285's saveBmeGroupResponsePrompts hardening:
 * visible drop-reason banner on every early-return + in-flight guard
 * + autosave-clearTimeout on submit.
 * ──────────────────────────────────────────────────────────── */

// Course-level question catalog. Hardcoded — these are course-shape
// questions, not content-shape; they don't change per cohort. If the
// admin wants different questions for the next cohort, V3.286+ can
// promote this to an admin-editable list on the schedule doc.
const BME_ASSESS_COURSE_QS = [
  { id: 'overall',  type: 'stars', label: 'Overall, how would you rate this course?' },
  { id: 'prepared', type: 'stars', label: 'How prepared do you feel for a college-level BME class?' },
  { id: 'pace',     type: 'pick',  label: 'The pace was…',
    options: [
      { value: 'too_slow',    label: 'Too slow' },
      { value: 'just_right',  label: 'Just right' },
      { value: 'too_fast',    label: 'Too fast' }
    ] },
  { id: 'groups',   type: 'stars', label: 'How well did the small-group discussions work for you?' },
  { id: 'liked_most',     type: 'text', label: 'What was the best part of the week?',
    placeholder: 'A favorite talk, lab tour, group conversation…' },
  { id: 'improve',        type: 'text', label: 'What would you change about the course?',
    placeholder: 'Pace, content, format, anything that made the week harder than it had to be…' },
  { id: 'recommend_text', type: 'text', label: "Anything you'd want a future student to know?",
    placeholder: 'Advice for next year\'s cohort…' },
  { id: 'staff_shoutout', type: 'text', label: 'Any shout-outs for the instructors or organizers?',
    placeholder: 'Optional — who helped you most this week?' }
];

function bmeAssessGateState() {
  const s = _classData?.assessmentState;
  return (s === 'open' || s === 'locked') ? s : 'closed';
}

function bmeAssessReadCurrent() {
  // Read the rendered form values into a fresh payload shape (without
  // status/timestamps — those are stamped by the save path).
  const payload = { ratings: {}, picks: {}, texts: {}, perSpeaker: {} };
  // Course-level inputs
  BME_ASSESS_COURSE_QS.forEach(q => {
    if (q.type === 'stars') {
      const cur = _bmeAssessment?.ratings?.[q.id];
      if (typeof cur === 'number') payload.ratings[q.id] = cur;
    } else if (q.type === 'pick') {
      const cur = _bmeAssessment?.picks?.[q.id];
      if (cur) payload.picks[q.id] = cur;
    } else if (q.type === 'text') {
      const ta = document.querySelector(`.cb295-assess-textarea[data-q-id="${q.id}"]`);
      if (ta) payload.texts[q.id] = ta.value || '';
      else if (_bmeAssessment?.texts?.[q.id]) payload.texts[q.id] = _bmeAssessment.texts[q.id];
    }
  });
  // Per-speaker
  const speakers = (_bmeContent?.speakers || []);
  speakers.forEach(sp => {
    const cur = _bmeAssessment?.perSpeaker?.[sp.slug] || null;
    const ta = document.querySelector(`.cb295-assess-speaker-comment[data-speaker-slug="${sp.slug}"]`);
    const stars = (cur && typeof cur.stars === 'number') ? cur.stars : null;
    const comment = ta ? (ta.value || '') : (cur?.comment || '');
    if (stars != null || (comment || '').trim()) {
      payload.perSpeaker[sp.slug] = {};
      if (stars != null) payload.perSpeaker[sp.slug].stars = stars;
      if (comment) payload.perSpeaker[sp.slug].comment = comment;
    }
  });
  const anonCb = document.getElementById('cb295-assess-anon');
  payload.anonymous = !!anonCb?.checked;
  return payload;
}

function renderBmeAssessmentBody(editing) {
  // V3.286 — assessment is admin-only-aggregated; the form itself is
  // student-facing. Admin sees the gate / histograms / free-text panels
  // inside the admin dashboard, NOT here — keeps this section focused
  // single-purpose for students (matches the user's feedback memory:
  // "Helper pages should be focused single-purpose tools").
  if (_viewType === 'admin' && !_adminViewOverride) {
    return `<p class="muted-text" style="padding:1rem 0;">
      Aggregated assessment results live on the <strong>Admin Dashboard</strong> tab
      (gate + histograms + free-text + per-speaker results). This tab is the form
      students see — switch to <em>View as → Student</em> to preview their experience.
    </p>`;
  }

  const auth = McgheeLab.Auth;
  const signedIn = !!auth?.currentUser || !!_adminViewOverride;
  if (!signedIn) {
    return `
      <section class="cb295-assess-panel cb295-assess-panel-signedout">
        <h3>Course assessment</h3>
        <p>Sign in with the Google account your instructor invited to submit your end-of-course feedback.</p>
        <a href="#/classes/bme295c/enroll" class="btn">Sign in</a>
      </section>
    `;
  }

  const entry = _bmeRosterEntry;
  if (!entry) {
    return `
      <section class="cb295-assess-panel cb295-assess-panel-norow">
        <h3>Course assessment</h3>
        <p class="muted-text">You're signed in, but your email isn't on the BME 295C roster. Ask your instructor to add you.</p>
      </section>
    `;
  }

  const gate = bmeAssessGateState();
  if (gate === 'closed') {
    return `
      <section class="cb295-assess-panel">
        <h3>Course assessment</h3>
        <div class="cb295-assess-closed-strip">
          <span aria-hidden="true">${ICON.svg('clock')}</span>
          <strong>Course assessment opens after the closing session on Friday.</strong>
          Check back at the end of the week to share your feedback.
        </div>
      </section>
    `;
  }

  const readonly = gate === 'locked';
  const a = _bmeAssessment || {};
  const ratings = a.ratings || {};
  const picks   = a.picks   || {};
  const texts   = a.texts   || {};
  const perSpeaker = a.perSpeaker || {};
  const anonChecked = !!a.anonymous;
  const status = a.status === 'submitted' ? 'submitted' : 'draft';

  // Question renderers — visual style matches V3.280 stars + V3.281 picks.
  const renderStars = (qid, value) => {
    const v = typeof value === 'number' ? value : 0;
    const btns = [1,2,3,4,5].map(n => `
      <button type="button"
              class="cb295-assess-star${v >= n ? ' cb295-assess-star-on' : ''}"
              data-q-id="${escAttr(qid)}"
              data-stars="${n}"
              ${readonly ? 'disabled' : ''}
              title="${n}/5 stars">${'★'.repeat(n)}${'☆'.repeat(5 - n)}</button>
    `).join('');
    const clear = (!readonly && v > 0) ? `
      <button type="button" class="cb295-assess-star-clear" data-q-id="${escAttr(qid)}" title="Clear">×</button>` : '';
    return `<div class="cb295-assess-star-row" data-q-id="${escAttr(qid)}">${btns}${clear}</div>`;
  };
  const renderPick = (q, value) => {
    return `<div class="cb295-assess-pick-row" data-q-id="${escAttr(q.id)}">
      ${q.options.map(opt => `
        <button type="button"
                class="cb295-assess-pick-btn${value === opt.value ? ' cb295-assess-pick-btn-active' : ''}"
                data-q-id="${escAttr(q.id)}"
                data-pick-value="${escAttr(opt.value)}"
                ${readonly ? 'disabled' : ''}>${esc(opt.label)}</button>
      `).join('')}
    </div>`;
  };
  const renderText = (q, value) => {
    const v = value || '';
    return readonly
      ? `<div class="cb295-assess-readonly-text">${v ? esc(v).replace(/\n/g, '<br>') : '<span class="muted-text">— blank —</span>'}</div>`
      : `<textarea class="cb295-assess-textarea"
                  data-q-id="${escAttr(q.id)}"
                  rows="3"
                  placeholder="${escAttr(q.placeholder || '')}">${esc(v)}</textarea>`;
  };

  const courseRows = BME_ASSESS_COURSE_QS.map(q => {
    let input;
    if (q.type === 'stars') input = renderStars(q.id, ratings[q.id]);
    else if (q.type === 'pick') input = renderPick(q, picks[q.id]);
    else input = renderText(q, texts[q.id]);
    return `
      <div class="cb295-assess-q cb295-assess-q-${esc(q.type)}">
        <label class="cb295-assess-q-label">${esc(q.label)}</label>
        ${input}
      </div>
    `;
  }).join('');

  // Per-speaker block — grouped by day to mirror the schedule tab cadence.
  const speakers = (_bmeContent?.speakers || []);
  const days = bmeCourseDays();
  const speakersByDay = days.map(d => ({
    day: d,
    speakers: speakers.filter(sp => bmeSpeakerDay(sp.slug) === d)
  })).filter(g => g.speakers.length);
  const orphans = speakers.filter(sp => !days.includes(bmeSpeakerDay(sp.slug)));
  if (orphans.length) speakersByDay.push({ day: '', speakers: orphans });

  const renderSpeakerRow = (sp) => {
    const cur = perSpeaker[sp.slug] || {};
    const stars = typeof cur.stars === 'number' ? cur.stars : 0;
    const comment = cur.comment || '';
    const starBtns = [1,2,3,4,5].map(n => `
      <button type="button"
              class="cb295-assess-speaker-star${stars >= n ? ' cb295-assess-speaker-star-on' : ''}"
              data-speaker-slug="${escAttr(sp.slug)}"
              data-stars="${n}"
              ${readonly ? 'disabled' : ''}
              title="${n}/5 stars">${'★'.repeat(n)}${'☆'.repeat(5 - n)}</button>
    `).join('');
    const clearBtn = (!readonly && stars > 0) ? `
      <button type="button" class="cb295-assess-speaker-star-clear"
              data-speaker-slug="${escAttr(sp.slug)}" title="Clear">×</button>` : '';
    const commentInput = readonly
      ? (comment
          ? `<div class="cb295-assess-readonly-text">${esc(comment).replace(/\n/g, '<br>')}</div>`
          : '<span class="muted-text">— no comment —</span>')
      : `<input type="text" class="cb295-assess-speaker-comment"
                data-speaker-slug="${escAttr(sp.slug)}"
                value="${escAttr(comment)}"
                placeholder="Optional comment for ${esc((sp.name || '').split(',')[0])}…" />`;
    return `
      <div class="cb295-assess-speaker-row" data-speaker-slug="${escAttr(sp.slug)}">
        <div class="cb295-assess-speaker-name">${esc((sp.name || '').split(',')[0])}</div>
        <div class="cb295-assess-speaker-stars">${starBtns}${clearBtn}</div>
        <div class="cb295-assess-speaker-comment-wrap">${commentInput}</div>
      </div>
    `;
  };

  const speakerSection = speakers.length ? `
    <details class="cb295-assess-speakers" open>
      <summary>
        <strong>Rate the speakers</strong>
        <span class="muted-text">Optional · ${speakers.length} speakers</span>
      </summary>
      ${speakersByDay.map(g => `
        <div class="cb295-assess-speaker-day-group">
          ${g.day ? `<h4 class="cb295-assess-speaker-day-head">${esc(g.day)}</h4>` : ''}
          ${g.speakers.map(renderSpeakerRow).join('')}
        </div>
      `).join('')}
    </details>
  ` : '';

  const lockedHeader = readonly ? `
    <div class="cb295-assess-locked-strip">
      <span aria-hidden="true">${ICON.svg('lock-closed')}</span>
      <strong>Assessment closed.</strong>
      Thank you for your feedback. Your responses below are read-only.
    </div>
  ` : '';

  const submitFooter = readonly ? '' : `
    <div class="cb295-assess-footer">
      <label class="cb295-assess-anon-row">
        <input type="checkbox" id="cb295-assess-anon" ${anonChecked ? 'checked' : ''} />
        <span>Submit anonymously</span>
        <span class="muted-text cb295-assess-anon-hint">(your name will be hidden from the admin's view; ratings still count toward the class total)</span>
      </label>
      <div class="cb295-assess-submit-row">
        <button type="button" class="btn cb295-assess-submit"
                data-status-target="${status === 'submitted' ? 'draft' : 'submitted'}">
          ${status === 'submitted' ? 'Edit response (mark draft)' : 'Submit assessment'}
        </button>
        <span class="cb295-assess-status muted-text">${status === 'submitted' ? '✓ Submitted — you can still edit.' : 'Draft — not yet submitted.'}</span>
      </div>
      <p class="muted-text cb295-assess-disclaimer">You can come back and edit any time until the assessment is locked.</p>
    </div>
  `;

  return `
    <section class="cb295-assess-panel">
      <header class="cb295-assess-head">
        <h3>Course assessment</h3>
        <p class="muted-text">Your feedback shapes next year's BME 295C. ~10 minutes; answer what you have time for.</p>
      </header>
      ${lockedHeader}
      <div class="cb295-assess-course">${courseRows}</div>
      ${speakerSection}
      ${submitFooter}
    </section>
  `;
}

function wireBme295cAssessment() {
  // Course-level stars
  document.querySelectorAll('.cb295-assess-star-row .cb295-assess-star').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      const qid = btn.dataset.qId;
      const n = parseInt(btn.dataset.stars, 10);
      if (!qid || !Number.isFinite(n)) return;
      if (!_bmeAssessment) _bmeAssessment = {};
      if (!_bmeAssessment.ratings) _bmeAssessment.ratings = {};
      _bmeAssessment.ratings[qid] = n;
      // Re-render this row inline so the user sees the new state.
      const row = btn.closest('.cb295-assess-star-row');
      if (row) {
        row.querySelectorAll('.cb295-assess-star').forEach(b => {
          const bn = parseInt(b.dataset.stars, 10);
          b.classList.toggle('cb295-assess-star-on', bn <= n);
        });
        // Show clear button if not already there
        if (!row.querySelector('.cb295-assess-star-clear')) {
          const clr = document.createElement('button');
          clr.type = 'button';
          clr.className = 'cb295-assess-star-clear';
          clr.dataset.qId = qid;
          clr.title = 'Clear';
          ICON.label(clr, 'x-mark');
          clr.addEventListener('click', () => bmeAssessClearStars(qid));
          row.appendChild(clr);
        }
      }
      bmeAssessQueueAutosave();
    });
  });

  document.querySelectorAll('.cb295-assess-star-row .cb295-assess-star-clear').forEach(btn => {
    btn.addEventListener('click', () => {
      const qid = btn.dataset.qId;
      if (qid) bmeAssessClearStars(qid);
    });
  });

  // Course-level pick buttons (3-way)
  document.querySelectorAll('.cb295-assess-pick-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      const qid = btn.dataset.qId;
      const v = btn.dataset.pickValue;
      if (!qid || !v) return;
      if (!_bmeAssessment) _bmeAssessment = {};
      if (!_bmeAssessment.picks) _bmeAssessment.picks = {};
      _bmeAssessment.picks[qid] = v;
      const row = btn.closest('.cb295-assess-pick-row');
      if (row) {
        row.querySelectorAll('.cb295-assess-pick-btn').forEach(b => {
          b.classList.toggle('cb295-assess-pick-btn-active', b.dataset.pickValue === v);
        });
      }
      bmeAssessQueueAutosave();
    });
  });

  // Free-text autosave — debounced 800ms (matches V3.251 response pattern)
  document.querySelectorAll('.cb295-assess-textarea').forEach(ta => {
    ta.addEventListener('input', () => {
      const qid = ta.dataset.qId;
      if (!qid) return;
      if (!_bmeAssessment) _bmeAssessment = {};
      if (!_bmeAssessment.texts) _bmeAssessment.texts = {};
      _bmeAssessment.texts[qid] = ta.value || '';
      bmeAssessSetStatusText('Saving…');
      bmeAssessQueueAutosave();
    });
  });

  // Per-speaker stars
  document.querySelectorAll('.cb295-assess-speaker-star').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      const slug = btn.dataset.speakerSlug;
      const n = parseInt(btn.dataset.stars, 10);
      if (!slug || !Number.isFinite(n)) return;
      if (!_bmeAssessment) _bmeAssessment = {};
      if (!_bmeAssessment.perSpeaker) _bmeAssessment.perSpeaker = {};
      if (!_bmeAssessment.perSpeaker[slug]) _bmeAssessment.perSpeaker[slug] = {};
      _bmeAssessment.perSpeaker[slug].stars = n;
      const row = btn.closest('.cb295-assess-speaker-row');
      if (row) {
        row.querySelectorAll('.cb295-assess-speaker-star').forEach(b => {
          const bn = parseInt(b.dataset.stars, 10);
          b.classList.toggle('cb295-assess-speaker-star-on', bn <= n);
        });
        if (!row.querySelector('.cb295-assess-speaker-star-clear')) {
          const clr = document.createElement('button');
          clr.type = 'button';
          clr.className = 'cb295-assess-speaker-star-clear';
          clr.dataset.speakerSlug = slug;
          clr.title = 'Clear';
          ICON.label(clr, 'x-mark');
          clr.addEventListener('click', () => bmeAssessClearSpeakerStars(slug));
          row.querySelector('.cb295-assess-speaker-stars')?.appendChild(clr);
        }
      }
      bmeAssessQueueAutosave();
    });
  });

  document.querySelectorAll('.cb295-assess-speaker-star-clear').forEach(btn => {
    btn.addEventListener('click', () => {
      const slug = btn.dataset.speakerSlug;
      if (slug) bmeAssessClearSpeakerStars(slug);
    });
  });

  // Per-speaker comment (input event, debounced)
  document.querySelectorAll('.cb295-assess-speaker-comment').forEach(inp => {
    inp.addEventListener('input', () => {
      const slug = inp.dataset.speakerSlug;
      if (!slug) return;
      if (!_bmeAssessment) _bmeAssessment = {};
      if (!_bmeAssessment.perSpeaker) _bmeAssessment.perSpeaker = {};
      if (!_bmeAssessment.perSpeaker[slug]) _bmeAssessment.perSpeaker[slug] = {};
      _bmeAssessment.perSpeaker[slug].comment = inp.value || '';
      bmeAssessSetStatusText('Saving…');
      bmeAssessQueueAutosave();
    });
  });

  // Anonymous toggle
  const anonCb = document.getElementById('cb295-assess-anon');
  if (anonCb) {
    anonCb.addEventListener('change', () => {
      if (!_bmeAssessment) _bmeAssessment = {};
      _bmeAssessment.anonymous = !!anonCb.checked;
      bmeAssessQueueAutosave();
    });
  }

  // Submit / unlock toggle (V3.285 in-flight guard pattern adapted to a
  // single-doc-per-student form, with the autosave clearTimeout to kill
  // any pending merge:true clobber).
  const submitBtn = document.querySelector('.cb295-assess-submit');
  if (submitBtn) {
    submitBtn.addEventListener('click', () => {
      if (_bmeAssessmentSubmitInFlight) {
        console.warn('[bme295c] assessment submit in flight — ignoring duplicate click');
        return;
      }
      _bmeAssessmentSubmitInFlight = true;
      submitBtn.disabled = true;
      clearTimeout(_bmeAssessmentSaveTimer);
      _bmeAssessmentSaveTimer = null;
      const safety = setTimeout(() => {
        _bmeAssessmentSubmitInFlight = false;
        submitBtn.disabled = false;
      }, 30000);
      const finish = () => {
        clearTimeout(safety);
        _bmeAssessmentSubmitInFlight = false;
        submitBtn.disabled = false;
      };
      const target = submitBtn.dataset.statusTarget === 'draft' ? 'draft' : 'submitted';
      Promise.resolve(saveBmeAssessment(bmeAssessReadCurrent(), target)).finally(finish);
    });
  }
}

function bmeAssessClearStars(qid) {
  if (_bmeAssessment?.ratings) delete _bmeAssessment.ratings[qid];
  const row = document.querySelector(`.cb295-assess-star-row[data-q-id="${qid}"]`);
  if (row) {
    row.querySelectorAll('.cb295-assess-star').forEach(b => b.classList.remove('cb295-assess-star-on'));
    row.querySelector('.cb295-assess-star-clear')?.remove();
  }
  bmeAssessQueueAutosave();
}

function bmeAssessClearSpeakerStars(slug) {
  if (_bmeAssessment?.perSpeaker?.[slug]) {
    delete _bmeAssessment.perSpeaker[slug].stars;
    if (Object.keys(_bmeAssessment.perSpeaker[slug]).length === 0) {
      delete _bmeAssessment.perSpeaker[slug];
    }
  }
  const row = document.querySelector(`.cb295-assess-speaker-row[data-speaker-slug="${slug}"]`);
  if (row) {
    row.querySelectorAll('.cb295-assess-speaker-star').forEach(b => b.classList.remove('cb295-assess-speaker-star-on'));
    row.querySelector('.cb295-assess-speaker-star-clear')?.remove();
  }
  bmeAssessQueueAutosave();
}

function bmeAssessSetStatusText(txt) {
  const el = document.querySelector('.cb295-assess-status');
  if (el) el.textContent = txt;
}

function bmeAssessQueueAutosave() {
  clearTimeout(_bmeAssessmentSaveTimer);
  _bmeAssessmentSaveTimer = setTimeout(() => {
    saveBmeAssessment(bmeAssessReadCurrent(), null);
  }, 800);
}

async function saveBmeAssessment(payload, statusOverride) {
  const auth = McgheeLab.Auth;
  const entry = _bmeRosterEntry;
  // V3.285 showDropReason pattern — visible reason + red button flash.
  const statusEl = document.querySelector('.cb295-assess-status');
  const submitBtn = document.querySelector('.cb295-assess-submit');
  const showDropReason = (reason, args) => {
    if (statusEl) statusEl.textContent = 'Cannot submit — ' + reason;
    if (submitBtn) {
      submitBtn.classList.add('cb295-response-submit-failed');
      setTimeout(() => submitBtn.classList.remove('cb295-response-submit-failed'), 6000);
    }
    if (args) console.warn('[bme295c] assessment save dropped — ' + reason, ...args);
  };

  if (_adminViewOverride) {
    showDropReason("admin preview can't submit on behalf of a student", []);
    return;
  }
  if (!auth?.currentUser) {
    showDropReason('not signed in (your session may have expired — hard-reload the page)', []);
    return;
  }
  if (!entry) {
    showDropReason("you're not on the class roster — ask your instructor to add you", []);
    return;
  }
  const gate = bmeAssessGateState();
  if (gate !== 'open') {
    showDropReason('course assessment is ' + gate + " — admin hasn't opened it for submissions",
                   ['gateState', gate]);
    return;
  }

  const uid = auth.currentUser.uid;
  const effCampus = bmeEffectiveCampus(entry, _bmeProfile) || '';
  const prior = _bmeAssessment || {};
  const status = statusOverride ?? prior.status ?? 'draft';

  const doc = {
    classId: _scheduleId,
    ratings: payload.ratings || {},
    picks:   payload.picks   || {},
    texts:   payload.texts   || {},
    perSpeaker: payload.perSpeaker || {},
    anonymous: !!payload.anonymous,
    status,
    campusAtWrite: effCampus,
    rosterIdAtWrite: entry.id || '',
    gateStateAtWrite: gate,
    lastEditedBy: uid,
    lastEditedName: entry.name || auth.currentUser.displayName || '',
    lastEditedAt: firebase.firestore.FieldValue.serverTimestamp(),
    appVersion: 'V3.286'
  };
  if (_classData?.testMode === true) doc.testMode = true;
  if (status === 'submitted' && prior.status !== 'submitted') {
    doc.submittedAt = firebase.firestore.FieldValue.serverTimestamp();
  }

  if (statusEl) statusEl.textContent = 'Saving…';

  try {
    await McgheeLab.db.collection('schedules').doc(_scheduleId)
      .collection('assessments').doc(uid).set(doc, { merge: true });
    _bmeAssessment = { ...prior, ...doc, lastEditedAt: new Date() };
    if (statusOverride) {
      // Status change — re-render to flip button label / locked banner.
      refreshCanvas();
    } else if (statusEl) {
      statusEl.textContent = status === 'submitted'
        ? '✓ Submitted — saved just now'
        : 'Draft — saved just now';
    }
  } catch (e) {
    console.error('[bme295c] assessment save failed', e);
    if (statusEl) statusEl.textContent = 'Save failed — ' + (e.message || e);
  }
}

/* ─── Test Mode panel (V3.250) ────────────────────────────────── */
function renderBmeTestModePanel() {
  // Global-admin only — the Firestore `groupResponses` delete rule is
  // `isAdmin()`, so class admins can't run the wipe.
  const isGlobalAdmin = McgheeLab.Auth?.currentProfile?.role === 'admin';
  if (!isGlobalAdmin) {
    return ''; // class admins don't see the test-mode controls
  }
  const on = _classData?.testMode === true;
  const roster = Array.isArray(_classData?.studentRoster) ? _classData.studentRoster : [];
  const testStudents = roster.filter(s => typeof s.id === 'string' && s.id.startsWith('TEST_'));
  const classAdminCount = Array.isArray(_classData?.classAdminEmails)
    ? _classData.classAdminEmails.length : 0;
  const dash = _bmeDashboardData;
  const taggedResponses = dash
    ? [...dash.responses.values()].filter(r => r.testMode === true).length
    : null;
  const taggedRespLabel = taggedResponses === null
    ? '<em class="muted-text">loading…</em>'
    : `<strong>${taggedResponses}</strong> response${taggedResponses === 1 ? '' : 's'} flagged for wipe`;
  // V3.251 — surface tagged Live Q&A chat message count too
  const taggedChat = dash?.chatMessages
    ? [...dash.chatMessages.values()].filter(m => m.testMode === true).length
    : null;
  const taggedChatLabel = taggedChat === null
    ? '<em class="muted-text">loading…</em>'
    : `<strong>${taggedChat}</strong> chat message${taggedChat === 1 ? '' : 's'} flagged for wipe`;
  return `
    <section class="cb295-dash-card cb295-testmode-card${on ? ' cb295-testmode-card-on' : ''}">
      <header class="cb295-dash-card-header">
        <h3>Test mode${on ? ' <span class="cb295-testmode-pill">ON</span>' : ''}</h3>
        <span class="muted-text" style="font-size:.8rem;">
          ${on
            ? 'Group response + chat writes are tagged for cleanup. Exit + wipe before launch.'
            : 'Toggle on to safely test the system end-to-end, then wipe before launch.'}
        </span>
      </header>
      <div class="cb295-testmode-stats">
        <div><span class="muted-text">Tagged responses</span><span>${taggedRespLabel}</span></div>
        <div><span class="muted-text">Tagged chat</span><span>${taggedChatLabel}</span></div>
        <div><span class="muted-text">TEST_* students</span><span><strong>${testStudents.length}</strong> in roster</span></div>
        <div><span class="muted-text">Class admins</span><span><strong>${classAdminCount}</strong> on the invite list</span></div>
      </div>
      <div class="cb295-testmode-actions">
        ${on
          ? `<button type="button" class="btn btn-small btn-secondary" id="cb295-testmode-exit">Exit test mode (keep data)</button>
             <button type="button" class="btn btn-small cb295-testmode-wipe" id="cb295-testmode-wipe">Wipe test data &amp; exit</button>`
          : `<button type="button" class="btn btn-small" id="cb295-testmode-enter">Enter test mode</button>`
        }
      </div>
      <p class="muted-text cb295-testmode-hint">
        ${on
          ? 'Wipe deletes every group-response and chat doc tagged <code>testMode:true</code>, removes all TEST_* students from the roster, and clears the class-admin email list. Manually-added students (MAN_*) and the real student roster stay put.'
          : 'When test mode is on, every group response and Course Chat message you (or anyone) submits gets a <code>testMode:true</code> tag. The wipe action targets only those tagged docs — real student work is never touched.'}
      </p>
    </section>
  `;
}

/* ─── Class Admins panel (V3.247, moved to dashboard in V3.249) ── */
function renderBmeClassAdminsPanel() {
  const classAdminEmails = Array.isArray(_classData?.classAdminEmails)
    ? _classData.classAdminEmails : [];
  const inviteUrl = `${location.origin}${location.pathname}#/classes/${esc(_scheduleId)}`;
  const ownerEmail = McgheeLab.Auth?.currentUser?.email || '';
  const ownerHere = _classData?.ownerUid && McgheeLab.Auth?.currentUser?.uid === _classData.ownerUid;
  return `
    <section class="cb295-dash-card">
      <header class="cb295-dash-card-header">
        <h3>Class admins</h3>
        <span class="muted-text" style="font-size:.8rem;">Co-admins for this class only — full admin powers on this page, nothing else.</span>
      </header>
      <ul class="cb295-classadmin-list">
        ${ownerHere ? `<li class="cb295-classadmin-row cb295-classadmin-owner">
          <span class="cb295-classadmin-email">${esc(ownerEmail || '(course owner)')}</span>
          <span class="cb295-classadmin-tag">Owner</span>
        </li>` : ''}
        ${classAdminEmails.length
          ? classAdminEmails.map((em) => `
            <li class="cb295-classadmin-row" data-classadmin-email="${escAttr(em)}">
              <span class="cb295-classadmin-email">${esc(em)}</span>
              <button type="button" class="btn btn-small cb295-classadmin-copy"
                      data-classadmin-email="${escAttr(em)}"
                      data-invite-url="${escAttr(inviteUrl)}"
                      title="Copy the class page link to send them">Copy invite link</button>
              <button type="button" class="btn btn-small btn-secondary cb295-classadmin-remove"
                      data-classadmin-email="${escAttr(em)}">Remove</button>
            </li>
          `).join('')
          : '<li class="muted-text" style="font-size:.85rem;">No co-admins yet — add up to a couple below.</li>'
        }
      </ul>
      <form class="cb295-classadmin-add" id="cb295-classadmin-add-form">
        <input type="email" id="cb295-classadmin-add-email" placeholder="coadmin@arizona.edu" autocomplete="off" required />
        <button type="submit" class="btn btn-small">+ Add admin</button>
      </form>
      <p class="muted-text cb295-classadmin-hint">
        After adding an email, click <strong>Copy invite link</strong> and paste it into your message to them. When they sign in with that email, they'll have admin powers on <code>#/classes/${esc(_scheduleId)}</code> automatically.
      </p>
    </section>
  `;
}

/* ─── Roster Management panel (V3.249, was roster295c body) ────── */
function renderBmeRosterMgmtPanel() {
  const roster = Array.isArray(_classData?.studentRoster) ? _classData.studentRoster : [];
  const campuses = ['', 'Tucson', 'Phoenix'];
  const days = bmeCourseDays();
  const isTestEntry = (s) => typeof s.id === 'string' && s.id.startsWith('TEST_');
  const hasTestEntries = roster.some(isTestEntry);

  // V3.251 — completion-signal badges sourced from the dashboard cache
  // (lazy, may be null on first paint). Each badge column shows ✓/—
  // once `_bmeDashboardData.profilesByEmail` lands; before that the
  // cells render as a muted "…" placeholder.
  const dash = _bmeDashboardData;
  const profiles = dash?.profilesByEmail || null;
  const responses = dash?.responses || null;
  // Count responses authored by each user (matched by uid → email)
  const respCountByEmail = new Map();
  if (responses && profiles) {
    responses.forEach(r => {
      if (!r.lastEditedBy) return;
      for (const [em, prof] of profiles.entries()) {
        if (prof.uid === r.lastEditedBy) {
          respCountByEmail.set(em, (respCountByEmail.get(em) || 0) + 1);
          break;
        }
      }
    });
  }
  const placeholder = '<span class="cb295-roster-badge-loading" title="Loading…">…</span>';
  const yesNo = (b, tipYes = '', tipNo = '') => b
    ? `<span class="cb295-dash-yes" title="${esc(tipYes)}">${ICON.svg('check')}</span>`
    : `<span class="cb295-dash-no" title="${esc(tipNo)}">—</span>`;

  const rows = roster.map((s, i) => {
    const dailyCells = days.map(d => {
      const v = (s.dailyGroups && typeof s.dailyGroups[d] === 'number') ? s.dailyGroups[d] : '';
      return `<input type="number" class="cb295-roster-daily" data-idx="${i}" data-day="${esc(d)}"
                     min="1" max="20" value="${v}" title="${esc(d)} group" />`;
    }).join('');
    const emailLc = (s.email || '').toLowerCase();
    const prof = profiles ? profiles.get(emailLc) : null;
    const bme = prof?.bme295c || {};
    // V3.278 — signedIn lifted out of the badge-cells branch so the
    // <tr> can pick up a row-level highlight class (the "In" column
    // alone wasn't visible enough at a glance).
    const signedIn = !!prof;
    let badgeCells;
    if (!profiles) {
      // Dashboard cache hasn't loaded yet — placeholders across the row.
      badgeCells = `
        <td class="cb295-roster-badge-col">${placeholder}</td>
        <td class="cb295-roster-badge-col">${placeholder}</td>
        <td class="cb295-roster-badge-col">${placeholder}</td>
        <td class="cb295-roster-badge-col">${placeholder}</td>
      `;
    } else {
      const hasBio = !!(bme.bio || '').trim();
      const hasPhoto = !!bme.photoUrl;
      const respN = respCountByEmail.get(emailLc) || 0;
      badgeCells = `
        <td class="cb295-roster-badge-col">${yesNo(signedIn, 'Signed in', 'Not signed in')}</td>
        <td class="cb295-roster-badge-col">${yesNo(hasBio, 'Bio filled', 'No bio')}</td>
        <td class="cb295-roster-badge-col">${yesNo(hasPhoto, 'Photo uploaded', 'No photo')}</td>
        <td class="cb295-roster-badge-col"><span class="cb295-roster-badge-count" title="Responses where this student was last editor">${respN}</span></td>
      `;
    }
    // V3.277 — Student ID + Email + Campus + High School collapsed into
    // one per-row <details> so the name + daily groups + status badges
    // (the columns admin scans during class) stay legible without a
    // horizontal scroll. Summary shows a compact campus chip so the
    // T/P split is visible without expanding.
    // V3.284 — when V3.272 override is in effect (effective campus ≠
    // roster campus), the chip surfaces both so the roster panel agrees
    // with the live monitor / grade discussions. Otherwise admin sees
    // a Tucson row in roster but a Phoenix column in the grids with no
    // explanation. Title spells out the consequence so the admin knows
    // whether they need to update roster.campus + re-run auto-assign.
    const effCampus = bmeStudentCampus(s);
    const overridden = !!s.campus && !!effCampus && effCampus !== s.campus;
    const baseChip = s.campus
      ? `<span class="cb295-roster-extras-chip cb295-roster-extras-chip-${esc(s.campus.toLowerCase())}" title="Roster campus${overridden ? ' (overridden by student → ' + esc(effCampus) + ')' : ''}">${esc(s.campus.charAt(0))}</span>`
      : '<span class="cb295-roster-extras-chip cb295-roster-extras-chip-none">—</span>';
    const overrideChip = overridden
      ? `<span class="cb295-roster-extras-chip cb295-roster-extras-chip-override cb295-roster-extras-chip-${esc(effCampus.toLowerCase())}" title="Student-set override (V3.272). Responses save under ${esc(effCampus)} group ${esc(String(bmeGetGroupForDay(s, days[0]) || '?'))} — but the dailyGroups[day] number was assigned in ${esc(s.campus)} context. Re-run auto-assign after updating roster.campus to keep groups balanced.">→ ${esc(effCampus.charAt(0))}</span>`
      : '';
    const campusChip = baseChip + overrideChip;
    const extrasCell = `
      <details class="cb295-roster-extras">
        <summary>
          ${campusChip}
          <span class="cb295-roster-extras-summary-hint">Details</span>
        </summary>
        <div class="cb295-roster-extras-body">
          <label class="cb295-roster-extras-field">
            <span>Student ID</span>
            <span class="muted-text">${esc(s.id)}</span>
          </label>
          <label class="cb295-roster-extras-field">
            <span>Email</span>
            <input type="email" class="cb295-roster-email" data-idx="${i}"
                   value="${escAttr(s.email || '')}" placeholder="student@…" />
          </label>
          <label class="cb295-roster-extras-field">
            <span>Campus</span>
            <select class="cb295-roster-campus" data-idx="${i}">
              ${campuses.map(c => `<option value="${esc(c)}" ${s.campus === c ? 'selected' : ''}>${c || '— none —'}</option>`).join('')}
            </select>
          </label>
          <label class="cb295-roster-extras-field">
            <span>High school</span>
            <input type="text" class="cb295-roster-highschool" data-idx="${i}"
                   value="${escAttr(s.highSchool || '')}" placeholder="High school" />
          </label>
        </div>
      </details>
    `;
    return `
      <tr data-roster-idx="${i}" class="${[
        isTestEntry(s) ? 'cb295-roster-test-row' : '',
        signedIn ? 'cb295-roster-row-signedin' : ''
      ].filter(Boolean).join(' ')}">
        <td class="cb295-roster-num">${i + 1}</td>
        <td>${esc(s.name)}${isTestEntry(s) ? ' <span class="cb295-roster-test-tag">TEST</span>' : ''}</td>
        <td class="cb295-roster-extras-cell">${extrasCell}</td>
        <td class="cb295-roster-daily-cell">
          <div class="cb295-roster-daily-row">${dailyCells}</div>
        </td>
        ${badgeCells}
        <td>
          <button type="button" class="btn btn-small btn-secondary cb295-roster-viewas"
                  data-student-id="${escAttr(s.id)}" title="Preview the page as this student">View as</button>
        </td>
        <td>
          <button type="button" class="btn btn-small btn-secondary cb295-roster-remove"
                  data-idx="${i}" title="Remove this student from the roster">×</button>
        </td>
      </tr>
    `;
  }).join('');

  // V3.278 — count students that have a matching `users/{email}` doc
  // so the panel header can show a "signed in" tally. Only meaningful
  // when the dashboard cache has loaded (otherwise placeholder).
  const signedInCount = profiles
    ? roster.filter(s => profiles.has((s.email || '').toLowerCase())).length
    : null;

  return `
    <section class="cb295-dash-card">
      <header class="cb295-dash-card-header">
        <h3>Roster &amp; daily groups (${roster.length} student${roster.length === 1 ? '' : 's'})</h3>
        <span class="muted-text" style="font-size:.8rem;">${
          roster.filter(s => s.campus === 'Tucson').length
        } Tucson · ${
          roster.filter(s => s.campus === 'Phoenix').length
        } Phoenix${
          signedInCount !== null
            ? ` · <span class="cb295-roster-signedin-chip">${signedInCount}/${roster.length} signed in</span>`
            : ''
        }</span>
      </header>
      <div class="cb295-roster-toolbar">
        <button type="button" class="btn btn-small" id="cb295-auto-assign">Auto-assign daily groups</button>
        <button type="button" class="btn btn-small btn-secondary" id="cb295-clear-groups">Clear groups</button>
        <span class="cb295-roster-toolbar-sep"></span>
        <button type="button" class="btn btn-small" id="cb295-add-student">+ Add student</button>
        <button type="button" class="btn btn-small btn-secondary" id="cb295-add-test-students">+ 4 test students</button>
        ${hasTestEntries
          ? `<button type="button" class="btn btn-small cb295-roster-clear-test" id="cb295-clear-test-students">Clear test students</button>`
          : ''}
        <span class="cb295-roster-toolbar-sep"></span>
        <button type="button" class="btn btn-small btn-secondary" id="cb295-roster-expand-all" title="Expand the Details column for every student">Expand all details</button>
        <button type="button" class="btn btn-small btn-secondary" id="cb295-roster-collapse-all" title="Collapse the Details column for every student">Collapse all</button>
      </div>
      <div class="muted-text" style="font-size:.8rem;margin-bottom:.5rem;">
        Auto-assign rotates groups across Mon–Fri so each student works with as many different classmates as possible (groups of 3–4 per campus, optimized by a 250-trial shuffle that minimizes repeat pairings). Edit any cell directly to override. <strong>Test students</strong> (prefix <code>TEST_</code>) inject sample data for QA; clear them before going live.
      </div>
      <div class="cb295-roster-tablewrap">
        <table class="cb295-roster-table">
          <thead>
            <tr>
              <th>#</th><th>Name</th>
              <th title="Student ID, email, campus, high school — click each row to expand">Details</th>
              <th>Groups <span class="muted-text" style="font-weight:normal;">(${days.map(d => esc(d.slice(0,3))).join(' · ')})</span></th>
              <th class="cb295-roster-badge-col" title="Signed in at least once">In</th>
              <th class="cb295-roster-badge-col" title="Bio filled">Bio</th>
              <th class="cb295-roster-badge-col" title="Photo uploaded">Pic</th>
              <th class="cb295-roster-badge-col" title="Group responses where this student was last editor">Resp</th>
              <th></th>
              <th></th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </section>
  `;
}

/** Open the manual add-student modal. Persists to studentRoster on save. */
function openBmeAddStudentModal() {
  closeBmeAddStudentModal();
  const modal = document.createElement('div');
  modal.id = 'cb295-add-student-modal';
  modal.className = 'cb295-modal-overlay';
  modal.innerHTML = `
    <div class="cb295-modal" role="dialog" aria-modal="true" aria-labelledby="cb295-add-student-title">
      <button type="button" class="cb295-modal-close" id="cb295-add-student-close" aria-label="Close">&times;</button>
      <h3 id="cb295-add-student-title">Add a student to the roster</h3>
      <form id="cb295-add-student-form" class="cb295-add-student-form">
        <div class="form-group">
          <label for="cb295-add-student-name">Name <span class="muted-text">(Last, First)</span></label>
          <input type="text" id="cb295-add-student-name" placeholder="Doe, Jane" required />
        </div>
        <div class="form-group">
          <label for="cb295-add-student-id">Student ID (Empl ID)</label>
          <input type="text" id="cb295-add-student-id" placeholder="24122572 — or leave blank to auto-generate" />
        </div>
        <div class="form-group">
          <label for="cb295-add-student-email">Email</label>
          <input type="email" id="cb295-add-student-email" placeholder="jane@arizona.edu" required />
        </div>
        <div class="cb295-add-student-row">
          <div class="form-group">
            <label for="cb295-add-student-campus">Campus</label>
            <select id="cb295-add-student-campus">
              <option value="">— none —</option>
              <option value="Tucson">Tucson</option>
              <option value="Phoenix">Phoenix</option>
            </select>
          </div>
          <div class="form-group">
            <label for="cb295-add-student-pronouns">Pronouns <span class="muted-text">(optional)</span></label>
            <input type="text" id="cb295-add-student-pronouns" placeholder="she/her, he/him, …" />
          </div>
        </div>
        <div class="form-group">
          <label for="cb295-add-student-hs">High school <span class="muted-text">(optional)</span></label>
          <input type="text" id="cb295-add-student-hs" placeholder="Cienega HS" />
        </div>
        <p class="muted-text" style="font-size:.8rem;">The new student won't have a daily group assigned until you click <strong>Auto-assign daily groups</strong> after adding them (or you can enter group numbers in the roster table manually).</p>
        <div class="cb295-modal-footer">
          <button type="button" class="btn btn-secondary" id="cb295-add-student-cancel">Cancel</button>
          <button type="submit" class="btn">Add student</button>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(modal);

  const close = () => closeBmeAddStudentModal();
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  document.getElementById('cb295-add-student-close')?.addEventListener('click', close);
  document.getElementById('cb295-add-student-cancel')?.addEventListener('click', close);

  document.getElementById('cb295-add-student-form')?.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const name = (document.getElementById('cb295-add-student-name')?.value || '').trim();
    let id = (document.getElementById('cb295-add-student-id')?.value || '').trim();
    const email = (document.getElementById('cb295-add-student-email')?.value || '').trim().toLowerCase();
    const campus = document.getElementById('cb295-add-student-campus')?.value || '';
    const pronouns = (document.getElementById('cb295-add-student-pronouns')?.value || '').trim();
    const highSchool = (document.getElementById('cb295-add-student-hs')?.value || '').trim();
    if (!name) { alert('Name is required.'); return; }
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      alert('Please enter a valid email.'); return;
    }
    if (!Array.isArray(_classData.studentRoster)) _classData.studentRoster = [];
    // Dedupe on email — case-insensitive.
    if (_classData.studentRoster.some(s => (s.email || '').toLowerCase() === email)) {
      alert('A student with that email is already on the roster.'); return;
    }
    if (!id) {
      // Auto-generate a stable id with prefix `MAN_` (manual) + counter.
      let n = 1;
      const existing = _classData.studentRoster.filter(s => typeof s.id === 'string' && s.id.startsWith('MAN_'));
      for (const s of existing) {
        const m = /^MAN_(\d+)$/.exec(s.id);
        if (m) n = Math.max(n, parseInt(m[1], 10) + 1);
      }
      id = `MAN_${n}`;
    } else if (_classData.studentRoster.some(s => s.id === id)) {
      alert(`A student with id ${id} is already on the roster.`); return;
    }
    _classData.studentRoster.push({
      id, name, pronouns, email, campus, highSchool,
      groupNumber: null,
      dailyGroups: {}
    });
    markDirty();
    persistAll().then(() => {
      close();
      refreshCanvas();
    });
  });

  setTimeout(() => document.getElementById('cb295-add-student-name')?.focus(), 50);
}

function closeBmeAddStudentModal() {
  document.getElementById('cb295-add-student-modal')?.remove();
}

/* ─── Wiring for the BME 295C sections (called from wireCanvas) ─── */
function wireBme295cCheckin() {
  // Sign out (button is on the strip when signed in or no roster match)
  document.getElementById('cb295-signout')?.addEventListener('click', async () => {
    try { await McgheeLab.auth.signOut(); location.reload(); } catch (e) {}
  });
  // Student "Edit your bio and information" → opens the bio modal.
  document.getElementById('cb295-open-bio-modal')?.addEventListener('click', openBmeBioModal);
  // V3.268 — Admin "Edit my profile" → jump to the admin dashboard tab
  // and scroll to the Instructors panel where photo + bio + contact
  // info for each instructor are edited. (The student bio modal is
  // group-rotation-aware and doesn't fit an admin who has no roster
  // entry, so admins land in the right editor instead.)
  document.getElementById('cb295-admin-edit-profile')?.addEventListener('click', () => {
    const adminTab = _tabs.find(t => (t.sections || []).some(s => s.key === 'adminDash295c'));
    if (!adminTab) return;
    if (_activeTabId !== adminTab.id) switchTab(adminTab.id);
    // refreshCanvas in switchTab is synchronous, but the section's
    // DOM is queryable on the next microtask after the innerHTML swap.
    // Defer the scroll one rAF so layout has settled.
    requestAnimationFrame(() => {
      const panel = document.getElementById('cb295-instructors-panel');
      if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
}

async function saveBmeProfile(opts = {}) {
  const auth = McgheeLab.Auth;
  if (!auth?.currentUser) return;
  const status = document.getElementById('cb295-profile-status');
  const bio = document.getElementById('cb295-bio')?.value || '';
  const interest = document.getElementById('cb295-interest')?.value || '';
  // V3.261 — `opts.targetUid` lets admins moderate other users' bios.
  // For admin-edit-other, we don't touch photoUrl/photoStoragePath
  // (admin can't upload to that user's Storage path anyway, and we
  // don't want to clobber an existing photo with a blank string).
  const targetUid = opts.targetUid || auth.currentUser.uid;
  const ownProfile = opts.ownProfile !== false && targetUid === auth.currentUser.uid;
  const payload = {
    bio,
    interest,
    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
  };
  if (ownProfile) {
    payload.photoUrl = _bmeProfile?.photoUrl || '';
    payload.photoStoragePath = _bmeProfile?.photoStoragePath || '';
    // V3.271 — student-selected campus override. Empty string means
    // "no override; fall back to the roster's admin-assigned campus."
    const campusEl = document.getElementById('cb295-profile-campus');
    if (campusEl) payload.campus = campusEl.value || '';
  }
  try {
    await McgheeLab.db.collection('users').doc(targetUid)
      .set({ bme295c: payload }, { merge: true });
    if (ownProfile) {
      _bmeProfile = { ..._bmeProfile, ...payload };
      if (auth.currentProfile) auth.currentProfile.bme295c = { ..._bmeProfile };
      // V3.256 — push the just-saved profile into the chat avatar cache
      // so the members sidebar / profile-view modal reflect new bio/photo
      // immediately (without waiting for the next chat-tab cold load).
      if (_bmeRosterEntry) _bmeOtherProfileCache.set(_bmeRosterEntry.id, { ..._bmeProfile, _uid: auth.currentUser.uid });
    } else if (opts.targetEntry) {
      // Admin moderation save — refresh the cache for the target so the
      // sidebar avatar/bio update without a full reload. Preserve the
      // existing photoUrl/photoStoragePath (we didn't write to them).
      const existing = _bmeOtherProfileCache.get(opts.targetEntry.id) || {};
      _bmeOtherProfileCache.set(opts.targetEntry.id, {
        ...existing,
        bio: payload.bio,
        interest: payload.interest,
        _uid: targetUid
      });
    }
    refreshBmeChatMembersAside();
    if (status) status.textContent = 'Saved.';
  } catch (e) {
    console.error('[BME295C] profile save failed', e);
    if (status) status.textContent = 'Save failed — ' + (e.message || e);
  }
}

async function uploadBmeProfilePhoto(ev) {
  const auth = McgheeLab.Auth;
  if (!auth?.currentUser) return;
  const file = ev.target.files?.[0];
  if (!file) return;
  const status = document.getElementById('cb295-photo-status');
  if (status) status.textContent = 'Uploading…';

  const ext = (file.name.match(/\.[a-zA-Z0-9]+$/) || ['.jpg'])[0];
  // Path is enforced by storage.rules — must be class-profile-photos/{classId}/{uid}/...
  const path = `class-profile-photos/bme295c/${auth.currentUser.uid}/photo${ext}`;
  try {
    const ref = firebase.storage().ref(path);
    await ref.put(file, { contentType: file.type || 'image/jpeg' });
    const url = await ref.getDownloadURL();

    _bmeProfile.photoUrl = url;
    _bmeProfile.photoStoragePath = path;
    await McgheeLab.db.collection('users').doc(auth.currentUser.uid).set({
      bme295c: {
        ...(_bmeProfile),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      }
    }, { merge: true });
    if (auth.currentProfile) auth.currentProfile.bme295c = { ..._bmeProfile };
    // V3.256 — push the new photo into the chat avatar cache so the
    // chat sidebar shows it on the next render.
    if (_bmeRosterEntry) _bmeOtherProfileCache.set(_bmeRosterEntry.id, { ..._bmeProfile, _uid: auth.currentUser.uid });
    refreshBmeChatMembersAside();

    // Reflect in the DOM without a full re-render
    const frame = document.getElementById('cb295-photo-frame');
    if (frame) frame.innerHTML = `<img src="${esc(url)}" alt="profile" />`;
    if (status) status.textContent = 'Uploaded.';
  } catch (e) {
    console.error('[BME295C] photo upload failed', e);
    if (status) status.textContent = 'Upload failed — ' + (e.message || e);
  }
}

/* ─── Modules tab wiring: confirm + response box ─────────── */
function wireBme295cModules() {
  // "Confirm my group" — write timestamp to user doc (legacy; only rendered
  // when banner falls back to single-group mode, which it no longer does).
  document.getElementById('cb295-confirm-group')?.addEventListener('click', confirmBmeGroup);
  // Daily-rotation strip clicks
  wireBmeRotationChips();

  // V3.251 — per-prompt response textareas. Each speaker has 3 textareas
  // (data-prompt-idx 0/1/2); typing in any of them autosaves the full
  // prompts payload after 800ms debounce. Per-prompt + total word
  // counters update live.
  document.querySelectorAll('.cb295-response-text-input').forEach(ta => {
    ta.addEventListener('input', () => {
      const slug = ta.dataset.speakerSlug;
      const promptIdx = ta.dataset.promptIdx;
      // Per-prompt word count
      const wcPer = document.querySelector(`.cb295-response-wordcount-per[data-speaker-slug="${slug}"][data-prompt-idx="${promptIdx}"]`);
      const nPer = countWords(ta.value);
      if (wcPer) wcPer.textContent = `${nPer} word${nPer === 1 ? '' : 's'}`;
      // Total word count across all 3 textareas of this speaker
      const total = bmeReadPromptsFromDom(slug);
      const sum = countWords(total[0]) + countWords(total[1]) + countWords(total[2]);
      const wcTotal = document.querySelector(`.cb295-response-wordcount[data-speaker-slug="${slug}"]`);
      if (wcTotal) wcTotal.textContent = `${sum} word${sum === 1 ? '' : 's'} total`;
      const status = document.querySelector(`.cb295-response-status[data-speaker-slug="${slug}"]`);
      if (status) status.textContent = 'Saving…';
      clearTimeout(_bmeResponseSaveTimers[slug]);
      _bmeResponseSaveTimers[slug] = setTimeout(() => {
        saveBmeGroupResponsePrompts(slug, bmeReadPromptsFromDom(slug), null, null);
      }, 800);
    });
  });

  // Submit / unlock toggle — V3.251 routes through the attendance modal
  // for new submits; unlocking (submitted → draft) skips the modal.
  // V3.285 — three new guards (audit ranks 8 + 12):
  //   (a) `_bmeSubmitInFlight` Set dedupes duplicate clicks while the
  //       first is still in flight — pre-V3.285 a double-click wiped
  //       the first modal and confused the student.
  //   (b) `clearTimeout(_bmeResponseSaveTimers[slug])` kills the pending
  //       800ms autosave so it can't race the submit's merge:true write
  //       and clobber `status='submitted'` back to `'draft'` (rank 8).
  //   (c) `onCancel` callback re-enables the button when the user
  //       dismisses the attendance modal without confirming (pre-V3.285
  //       the button stayed disabled forever on cancel).
  document.querySelectorAll('.cb295-response-submit').forEach(btn => {
    btn.addEventListener('click', () => {
      const slug = btn.dataset.speakerSlug;
      if (_bmeSubmitInFlight.has(slug)) {
        console.warn('[bme295c] submit in flight for', slug, '— ignoring duplicate click');
        return;
      }
      _bmeSubmitInFlight.add(slug);
      btn.disabled = true;
      // Kill any pending autosave so it can't merge:true clobber the
      // submit. (Rank 8 in V3.285 audit wf_622dff3f-796.)
      clearTimeout(_bmeResponseSaveTimers[slug]);
      _bmeResponseSaveTimers[slug] = null;
      // Safety net — never strand the button if something hangs.
      const safetyTimer = setTimeout(() => {
        _bmeSubmitInFlight.delete(slug);
        btn.disabled = false;
      }, 30000);
      const finish = () => {
        clearTimeout(safetyTimer);
        _bmeSubmitInFlight.delete(slug);
        btn.disabled = false;
      };

      const current = _bmeGroupResponses?.get(slug) || null;
      const prompts = bmeReadPromptsFromDom(slug);
      if (current?.status === 'submitted') {
        // Unlock — flip back to draft without an attendance check.
        Promise.resolve(saveBmeGroupResponsePrompts(slug, prompts, 'draft', null)).finally(finish);
        return;
      }
      // New submission — open the attendance modal first.
      openBmeAttendanceModal(slug, prompts, (attendance) => {
        Promise.resolve(
          saveBmeGroupResponsePrompts(slug, prompts, 'submitted', { attendance })
        ).finally(finish);
      }, finish);
    });
  });
}

/** Read the 3 per-prompt textareas for a given speaker out of the DOM,
 * returning a `{0,1,2}` map. Used by the input autosave + submit handler.
 */
function bmeReadPromptsFromDom(speakerSlug) {
  const out = { 0: '', 1: '', 2: '' };
  document.querySelectorAll(`.cb295-response-text-input[data-speaker-slug="${speakerSlug}"]`).forEach(ta => {
    const idx = parseInt(ta.dataset.promptIdx, 10);
    if (Number.isFinite(idx)) out[idx] = ta.value || '';
  });
  return out;
}

/** V3.251 — attendance check modal. Pops on Submit, asks whether all
 * groupmates are present, optionally reveals a checklist of group
 * members for the day. `onConfirm({ presentIds, absentIds, recordedBy,
 * recordedAt })` fires once the user confirms.
 */
function openBmeAttendanceModal(speakerSlug, currentPrompts, onConfirm, onCancel) {
  closeBmeAttendanceModal();
  const auth = McgheeLab.Auth;
  // V3.285 — every early-return now also fires onCancel so the caller's
  // in-flight guard (`_bmeSubmitInFlight`) clears. Pre-V3.285 a bail
  // here stranded the submit button disabled forever.
  if (!auth?.currentUser) { if (typeof onCancel === 'function') onCancel(); return; }

  const entry = _bmeRosterEntry;
  if (!entry) { if (typeof onCancel === 'function') onCancel(); return; }
  const day = bmeSpeakerDay(speakerSlug);
  const dayGroup = bmeGetGroupForDay(entry, day);
  const myCampus = bmeEffectiveCampus(entry, _bmeProfile);
  // Group members for this speaker's day — includes self.
  const roster = Array.isArray(_classData?.studentRoster) ? _classData.studentRoster : [];
  const groupMembers = roster.filter(r =>
    bmeEffectiveCampus(r, bmeProfileFor(r)) === myCampus &&
    bmeGetGroupForDay(r, day) === dayGroup
  );

  const emptyPrompts = [0, 1, 2].filter(i => !((currentPrompts && currentPrompts[i]) || '').trim());
  const emptyWarning = emptyPrompts.length > 0
    ? `<p class="cb295-att-warning">
         <strong>Heads up:</strong> ${emptyPrompts.length === 3 ? 'all 3 prompts are' : emptyPrompts.length + ' prompt' + (emptyPrompts.length === 1 ? ' is' : 's are')} empty.
         <label style="display:block;margin-top:.35rem;">
           <input type="checkbox" id="cb295-att-empty-ack" />
           Yes, I meant to submit ${emptyPrompts.length === 1 ? 'it' : 'them'} empty
         </label>
       </p>`
    : '';

  const modal = document.createElement('div');
  modal.id = 'cb295-attendance-modal';
  modal.className = 'cb295-modal-overlay';
  modal.innerHTML = `
    <div class="cb295-modal" role="dialog" aria-modal="true" aria-labelledby="cb295-att-title">
      <button type="button" class="cb295-modal-close" id="cb295-att-close" aria-label="Close">&times;</button>
      <h3 id="cb295-att-title">Submit response — quick check</h3>
      <div class="cb295-att-body">
        ${emptyWarning}
        <p style="margin:0 0 .75rem;">Are all your group mates present?</p>
        <div class="cb295-att-stage" data-stage="initial">
          <div class="cb295-modal-footer">
            <button type="button" class="btn btn-secondary" id="cb295-att-cancel">Cancel</button>
            <button type="button" class="btn" id="cb295-att-mark">No, mark absences</button>
            <button type="button" class="btn" id="cb295-att-allpresent">Yes, all present</button>
          </div>
        </div>
        <div class="cb295-att-stage cb295-att-checklist" data-stage="checklist" hidden>
          <p class="muted-text" style="font-size:.85rem;margin:.25rem 0 .5rem;">Check anyone who is <strong>absent</strong>. The rest will be marked present.</p>
          <ul class="cb295-att-list">
            ${groupMembers.map(m => `
              <li>
                <label>
                  <input type="checkbox" data-student-id="${escAttr(m.id)}" />
                  ${esc((m.name || '').split(',')[0])}${m.id === entry.id ? ' <span class="muted-text">(you)</span>' : ''}
                </label>
              </li>
            `).join('')}
          </ul>
          <div class="cb295-modal-footer">
            <button type="button" class="btn btn-secondary" id="cb295-att-back">Back</button>
            <button type="button" class="btn" id="cb295-att-confirm">Submit response</button>
          </div>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  // V3.285 — `confirmed` flag separates cancel-close from confirm-close.
  // On confirm we close + fire onConfirm. On cancel (X / Cancel / overlay
  // click) we close + fire onCancel so the submit-handler in-flight guard
  // can release the button. Pre-V3.285 dismissing the modal without
  // confirming stranded the submit button disabled forever.
  let confirmed = false;
  const close = () => {
    closeBmeAttendanceModal();
    if (!confirmed && typeof onCancel === 'function') onCancel();
  };
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  document.getElementById('cb295-att-close')?.addEventListener('click', close);
  document.getElementById('cb295-att-cancel')?.addEventListener('click', close);

  const checkEmptyGate = () => {
    if (emptyPrompts.length === 0) return true;
    const ack = document.getElementById('cb295-att-empty-ack');
    if (ack && !ack.checked) {
      alert(`Tick the "Yes, I meant to submit ${emptyPrompts.length === 1 ? 'it' : 'them'} empty" box first, or fill the empty prompt${emptyPrompts.length === 1 ? '' : 's'}.`);
      return false;
    }
    return true;
  };

  document.getElementById('cb295-att-allpresent')?.addEventListener('click', () => {
    if (!checkEmptyGate()) return;
    const presentIds = groupMembers.map(m => m.id);
    const absentIds = [];
    confirmed = true;
    close();
    onConfirm(bmeMakeAttendance(presentIds, absentIds));
  });

  document.getElementById('cb295-att-mark')?.addEventListener('click', () => {
    if (!checkEmptyGate()) return;
    // Reveal the checklist stage; hide the initial stage.
    modal.querySelector('[data-stage="initial"]')?.setAttribute('hidden', '');
    modal.querySelector('[data-stage="checklist"]')?.removeAttribute('hidden');
  });

  document.getElementById('cb295-att-back')?.addEventListener('click', () => {
    modal.querySelector('[data-stage="checklist"]')?.setAttribute('hidden', '');
    modal.querySelector('[data-stage="initial"]')?.removeAttribute('hidden');
  });

  document.getElementById('cb295-att-confirm')?.addEventListener('click', () => {
    const absentIds = [];
    modal.querySelectorAll('.cb295-att-list input[type="checkbox"]:checked').forEach(cb => {
      absentIds.push(cb.dataset.studentId);
    });
    const presentIds = groupMembers
      .map(m => m.id)
      .filter(id => !absentIds.includes(id));
    confirmed = true;
    close();
    onConfirm(bmeMakeAttendance(presentIds, absentIds));
  });
}

function closeBmeAttendanceModal() {
  document.getElementById('cb295-attendance-modal')?.remove();
}

function bmeMakeAttendance(presentIds, absentIds) {
  const auth = McgheeLab.Auth;
  return {
    presentIds: presentIds || [],
    absentIds: absentIds || [],
    recordedBy: auth?.currentUser?.uid || '',
    recordedAt: firebase.firestore.FieldValue.serverTimestamp()
  };
}

/** Wire the day-strip chips on the group banner. Pulled out so we can
 * re-bind only the chips after replacing the banner in-place (avoids
 * double-binding the response-textarea autosave handlers).
 */
function wireBmeRotationChips() {
  document.querySelectorAll('.cb295-group-banner-daily .cb295-rotation-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const day = chip.dataset.day;
      if (!day) return;
      _bmeBannerFocusDay = day;
      const banner = document.querySelector('.cb295-group-banner-daily');
      if (!banner) return;
      const auth = McgheeLab.Auth;
      const fresh = buildBmeGroupBanner(!!auth?.currentUser);
      const tmp = document.createElement('div');
      tmp.innerHTML = fresh;
      const next = tmp.firstElementChild;
      if (next) {
        banner.replaceWith(next);
        wireBmeRotationChips();
      }
    });
  });
  // V3.255 — "Send Chat to instructor" link in the banner footer
  // switches to the Live Q&A tab so the student can post directly.
  document.getElementById('cb295-goto-chat')?.addEventListener('click', () => {
    const chatTab = _tabs.find(t => (t.sections || []).some(s => s.key === 'chat295c'));
    if (chatTab) switchTab(chatTab.id);
  });
}

async function confirmBmeGroup() {
  const auth = McgheeLab.Auth;
  const entry = _bmeRosterEntry;
  if (!auth?.currentUser || !entry || !entry.groupNumber || !entry.campus) return;

  const confirmedKey = `${entry.campus}-${entry.groupNumber}`;
  const payload = {
    ...(_bmeProfile || { bio: '', interest: '', photoUrl: '', photoStoragePath: '' }),
    groupConfirmedAt: firebase.firestore.FieldValue.serverTimestamp(),
    groupConfirmedKey: confirmedKey,
    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
  };

  try {
    await McgheeLab.db.collection('users').doc(auth.currentUser.uid)
      .set({ bme295c: payload }, { merge: true });
    _bmeProfile = { ...payload };
    if (auth.currentProfile) auth.currentProfile.bme295c = { ...payload };
    // Re-render the modules section so the banner flips to the confirmed state
    refreshCanvas();
  } catch (e) {
    alert('Confirm failed: ' + (e.message || e));
  }
}

/** V3.251 — write the 3 per-prompt response strings for the current
 * user's group on this speaker. `prompts` is `{0,1,2}` (string per
 * index). `statusOverride` flips draft↔submitted; `extras` carries
 * attendance + submittedAt timestamps from the attendance modal.
 *
 * Replaces the V3.244 `saveBmeGroupResponse(slug, text, ...)` which
 * wrote a single `text` field. Legacy docs are normalized at read
 * time via `bmeNormalizeResponse`; the first new write here flips
 * the doc to the new shape (we do NOT carry the old `text` field
 * forward — once `prompts` exists, `text` becomes dead data).
 */
async function saveBmeGroupResponsePrompts(speakerSlug, prompts, statusOverride, extras) {
  const auth = McgheeLab.Auth;
  const entry = _bmeRosterEntry;
  const day = bmeSpeakerDay(speakerSlug);
  const dayGroup = bmeGetGroupForDay(entry, day);
  // V3.271 — campus key on the response doc id picks up student's
  // self-selected campus override (falls back to roster entry).
  const effCampus = bmeEffectiveCampus(entry, _bmeProfile);
  // V3.285 — every early-return now writes a human-readable reason to
  // statusEl + flashes the submit button red. Pre-V3.285, the four
  // preconditions just hit console.warn + return, so the student saw
  // no feedback at all. The console.warns stay (admin diagnostic).
  const statusEl = document.querySelector(`.cb295-response-status[data-speaker-slug="${speakerSlug}"]`);
  const submitBtn = document.querySelector(`.cb295-response-submit[data-speaker-slug="${speakerSlug}"]`);
  const showDropReason = (reason, consoleArgs) => {
    if (statusEl) statusEl.textContent = 'Cannot submit — ' + reason;
    if (submitBtn) {
      submitBtn.classList.add('cb295-response-submit-failed');
      setTimeout(() => submitBtn.classList.remove('cb295-response-submit-failed'), 6000);
    }
    if (consoleArgs) console.warn('[bme295c] save dropped — ' + reason, ...consoleArgs);
  };

  if (!auth?.currentUser) {
    showDropReason('not signed in (your session may have expired — hard-reload the page)', []);
    return;
  }
  if (!entry) {
    showDropReason("you're not on the class roster (sign in with the same email the admin invited)", ['slug:', speakerSlug]);
    return;
  }
  if (!dayGroup) {
    showDropReason('your group for ' + (day || 'this day') + ' has not been assigned yet — ask your instructor',
                   ['entry', entry.id, 'day', JSON.stringify(day), 'slug', speakerSlug, 'dailyGroups', entry.dailyGroups]);
    return;
  }
  if (!effCampus) {
    showDropReason('no campus set on your roster row — ask your instructor', ['entry', entry.id, 'slug:', speakerSlug]);
    return;
  }
  // V3.285 — server-aligned gate check (Fix 5). Blocks save when admin
  // has closed the discussion, even if the student's client cache still
  // has gateState='open'. Pair with the V3.285 schedule-doc onSnapshot
  // (Fix 4) which keeps the cache fresh in the first place.
  const gateState = bmeGetDiscussionState(speakerSlug);
  if (gateState !== 'open') {
    showDropReason("discussion is " + gateState + " — admin hasn't released it yet",
                   ['slug', speakerSlug, 'gateState', gateState]);
    return;
  }

  const docId = bmeResponseDocId(effCampus, dayGroup, speakerSlug);
  if (statusEl) statusEl.textContent = 'Saving…';

  const current = _bmeGroupResponses?.get(speakerSlug) || null;
  const status = statusOverride ?? current?.status ?? 'draft';

  const normalizedPrompts = {
    0: (prompts && prompts[0]) || '',
    1: (prompts && prompts[1]) || '',
    2: (prompts && prompts[2]) || ''
  };
  const wordCount =
    countWords(normalizedPrompts[0]) +
    countWords(normalizedPrompts[1]) +
    countWords(normalizedPrompts[2]);

  const payload = {
    classId: _scheduleId,
    speakerSlug,
    day: day || '',
    campus: effCampus,
    groupNumber: dayGroup,
    prompts: normalizedPrompts,
    wordCount,
    status,
    // V3.285 — gate state at write-time, stamped on every doc so admin
    // can forensically detect any post-V3.285 writes that landed past a
    // closed gate (filter on `gateStateAtWrite !== 'open'`). With the
    // gate-check above this should never happen, but the audit trail
    // makes any regression instantly visible.
    gateStateAtWrite: gateState,
    lastEditedBy: auth.currentUser.uid,
    lastEditedName: entry.name || auth.currentUser.displayName || '',
    lastEditedAt: firebase.firestore.FieldValue.serverTimestamp()
  };
  // V3.250 — tag writes made while the class is in test mode so the
  // "Wipe test data" button can find + delete them in one query.
  if (_classData?.testMode === true) payload.testMode = true;
  if (status === 'submitted' && current?.status !== 'submitted') {
    payload.submittedAt = firebase.firestore.FieldValue.serverTimestamp();
  }
  if (extras?.attendance) payload.attendance = extras.attendance;

  try {
    await McgheeLab.db.collection('schedules').doc(_scheduleId)
      .collection('groupResponses').doc(docId).set(payload, { merge: true });
    // Cache update — wrap in normalizer so subsequent reads see prompts.
    _bmeGroupResponses.set(speakerSlug, bmeNormalizeResponse({ id: docId, ...payload, lastEditedAt: new Date() }));
    if (statusOverride) {
      // Status changed — re-render this card to flip button label / styling
      refreshCanvas();
    } else if (statusEl) {
      statusEl.textContent = `Saved by ${payload.lastEditedName} · just now`;
    }
  } catch (e) {
    console.error('[BME295C] response save failed', e);
    if (statusEl) statusEl.textContent = 'Save failed — ' + (e.message || e);
  }
}

/* ─── Admin Dashboard (V3.248) ──────────────────────────────── */
/** Lazy-load the dashboard's auxiliary data: every roster student's
 * `users/{uid}.bme295c` profile (matched by email), plus every
 * `groupResponses` doc on this schedule. Triggered on first render of
 * the dashboard section; cached in `_bmeDashboardData` for the page
 * lifetime. Re-renders the dashboard once the load completes.
 */
async function loadBmeDashboardData() {
  if (_bmeDashboardData || _bmeDashboardLoading) return;
  _bmeDashboardLoading = true;
  const roster = Array.isArray(_classData?.studentRoster) ? _classData.studentRoster : [];
  const emails = roster.map(s => (s.email || '').trim()).filter(Boolean);
  const profilesByEmail = new Map();
  // Chunk into groups of 10 — Firestore `in` operator's max.
  for (let i = 0; i < emails.length; i += 10) {
    const chunk = emails.slice(i, i + 10);
    try {
      const snap = await McgheeLab.db.collection('users').where('email', 'in', chunk).get();
      snap.docs.forEach(d => {
        const data = d.data() || {};
        const email = (data.email || '').toLowerCase();
        if (email) profilesByEmail.set(email, { uid: d.id, ...data });
      });
    } catch (e) {
      console.warn('[BME295C dashboard] users chunk fetch failed', e);
    }
  }
  const responses = new Map();
  // V3.251 — initial one-shot read for fast first paint. The onSnapshot
  // listener (attachBmeDashboardListener, called below) takes over for
  // live updates after this returns.
  try {
    const snap = await McgheeLab.db.collection('schedules').doc(_scheduleId)
      .collection('groupResponses').get();
    snap.docs.forEach(d => responses.set(d.id, bmeNormalizeResponse({ id: d.id, ...d.data() })));
  } catch (e) {
    console.warn('[BME295C dashboard] groupResponses fetch failed', e);
  }
  // V3.251 — also pull the Live Q&A chat collection so the test-mode
  // panel can report the tagged-chat count + future dashboards have
  // visibility into chat volume.
  const chatMessages = new Map();
  try {
    const snap = await McgheeLab.db.collection('schedules').doc(_scheduleId)
      .collection('classQA').get();
    snap.docs.forEach(d => chatMessages.set(d.id, { id: d.id, ...d.data() }));
  } catch (e) {
    console.warn('[BME295C dashboard] classQA fetch failed', e);
  }
  // V3.286 — pull every student's course-assessment doc for the admin
  // aggregated panels. Read rule allows admin to read all. The
  // attachBmeAssessmentsListener (called below) keeps this in sync as
  // students submit live.
  const assessments = new Map();
  try {
    const snap = await McgheeLab.db.collection('schedules').doc(_scheduleId)
      .collection('assessments').get();
    snap.docs.forEach(d => assessments.set(d.id, { id: d.id, ...d.data() }));
  } catch (e) {
    console.warn('[BME295C dashboard] assessments fetch failed', e);
  }
  _bmeDashboardData = { profilesByEmail, responses, chatMessages, assessments };
  _bmeDashboardLoading = false;

  // V3.284 — roster-wide integrity check. Surfaces in DevTools every
  // case where a student's effective campus (V3.272 override) diverges
  // from their roster campus, so the roster ⇄ live-monitor "wrong group"
  // signal the user reported has a single grep-able log line. Also lists
  // students with empty campus or empty dailyGroups maps so missing
  // assignments don't masquerade as "wrong group routing".
  try {
    const roster = Array.isArray(_classData?.studentRoster) ? _classData.studentRoster : [];
    const overrides = [];
    const noCampus = [];
    const noGroups = [];
    roster.forEach(s => {
      const eff = bmeStudentCampus(s);
      if (eff && s.campus && eff !== s.campus) {
        overrides.push({ id: s.id, name: s.name, rosterCampus: s.campus, effectiveCampus: eff });
      }
      if (!s.campus) noCampus.push({ id: s.id, name: s.name });
      if (!s.dailyGroups || !Object.values(s.dailyGroups).some(v => typeof v === 'number')) {
        noGroups.push({ id: s.id, name: s.name, campus: s.campus });
      }
    });
    if (overrides.length) {
      console.warn('[bme295c] integrity — students with campus override (roster ≠ effective). Responses save under the EFFECTIVE column but the roster panel still lists them under the roster column. Admin should either (a) update roster.campus to match the override, OR (b) ignore — admin grids use effective campus and live monitor will reflect the override.', overrides);
    }
    if (noCampus.length) console.warn('[bme295c] integrity — students without a campus assigned (they cannot save responses):', noCampus);
    if (noGroups.length) console.warn('[bme295c] integrity — students without any dailyGroups assigned (run auto-assign):', noGroups);
  } catch (e) {
    console.warn('[bme295c] integrity check threw', e);
  }
  // Re-render so the populated data replaces the loading placeholder.
  // Only refresh if the dashboard tab is still active.
  const tab = getActiveTab();
  if (tab?.sections?.some(s => s.key === 'adminDash295c')) {
    refreshCanvas();
  } else if (tab?.sections?.some(s => s.key === 'chat295c')) {
    // V3.254 — chat tab uses the same profile cache for sidebar
    // avatars. Update the cache from the dashboard profile data so any
    // bme295c subdocs the dashboard pulled also flow to the sidebar,
    // then swap only the <aside> so we don't disturb the live
    // onSnapshot listener on the feed.
    seedBmeChatCacheFromDashboard();
    refreshBmeChatMembersAside();
  }
  // V3.251 — kick off the realtime listener for the live monitor.
  attachBmeDashboardListener();
  // V3.286 — and the assessments listener so admin sees submissions
  // land in real time on the new dashboard panels.
  attachBmeAssessmentsListener();
}

/** V3.254 — fold any user-doc profiles the dashboard loader pulled
 * into `_bmeOtherProfileCache` so the chat sidebar (which keys by
 * student id) can read them. Keeps the two caches in sync without
 * duplicating Firestore reads.
 */
function seedBmeChatCacheFromDashboard() {
  if (!_bmeDashboardData?.profilesByEmail) return;
  const roster = Array.isArray(_classData?.studentRoster) ? _classData.studentRoster : [];
  for (const s of roster) {
    const em = (s.email || '').toLowerCase();
    if (!em) continue;
    const profile = _bmeDashboardData.profilesByEmail.get(em);
    if (profile?.bme295c && !_bmeOtherProfileCache.get(s.id)?.photoUrl) {
      _bmeOtherProfileCache.set(s.id, { ...profile.bme295c, _uid: profile.uid });
    }
  }
}

/** V3.251 — open an onSnapshot subscription on the groupResponses
 * collection so the live monitor reflects new submissions/edits within
 * seconds. Calls `rerenderBmeLiveMonitor()` (surgical DOM swap) on each
 * delta so the admin's scroll position survives.
 *
 * Idempotent: subsequent calls are no-ops if already attached. Detach
 * via detachBmeDashboardListener() (wired into cleanupListeners).
 */
function attachBmeDashboardListener() {
  if (_bmeDashboardUnsub) return;
  try {
    _bmeDashboardUnsub = McgheeLab.db.collection('schedules').doc(_scheduleId)
      .collection('groupResponses').onSnapshot((snap) => {
        if (!_bmeDashboardData) return; // initial load not done yet — skip
        let changed = false;
        snap.docChanges().forEach(c => {
          const id = c.doc.id;
          if (c.type === 'removed') {
            _bmeDashboardData.responses.delete(id);
            changed = true;
          } else {
            _bmeDashboardData.responses.set(id, bmeNormalizeResponse({ id, ...c.doc.data() }));
            changed = true;
          }
        });
        if (changed) rerenderBmeLiveMonitor();
      }, (err) => {
        console.warn('[BME295C dashboard] onSnapshot error', err);
      });
  } catch (e) {
    console.warn('[BME295C dashboard] attach listener failed', e);
  }
  // Start the timestamp-refresh interval (re-runs fmtRelativeTime
  // against cached cell timestamps every 30s).
  if (!_bmeMonitorTickInterval) {
    _bmeMonitorTickInterval = setInterval(() => {
      document.querySelectorAll('.cb295-monitor-when[data-edited-ms]').forEach(el => {
        const ms = parseInt(el.dataset.editedMs, 10);
        if (Number.isFinite(ms)) el.textContent = fmtRelativeTime(new Date(ms));
      });
    }, 30000);
  }
}

function fmtRelativeTime(d) {
  if (!d) return '';
  const t = d instanceof Date ? d : (d.toDate ? d.toDate() : new Date(d));
  if (!(t instanceof Date) || isNaN(t.getTime())) return '';
  const secs = Math.round((Date.now() - t.getTime()) / 1000);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
  return `${Math.round(secs / 86400)}d ago`;
}

function renderBmeAdminDashBody(editing) {
  if (_viewType !== 'admin') {
    return '<p class="muted-text">This dashboard is only visible to course admins.</p>';
  }
  // Kick off the data load on first render; the call is idempotent.
  if (!_bmeDashboardData) {
    loadBmeDashboardData();
  }
  const dash = _bmeDashboardData;
  const loading = !dash;

  const roster = Array.isArray(_classData?.studentRoster) ? _classData.studentRoster : [];
  const days = bmeCourseDays();
  const speakers = (_bmeContent?.speakers || []);
  const responses = dash?.responses || new Map();
  const profiles = dash?.profilesByEmail || new Map();

  // ── Class metadata strip ──
  const metaRow = (label, val) => `
    <div class="cb295-dash-meta-row">
      <span class="cb295-dash-meta-label">${esc(label)}</span>
      <span class="cb295-dash-meta-val">${val}</span>
    </div>
  `;
  const ownerEmail = (() => {
    if (!_classData?.ownerUid) return '<em class="muted-text">unset</em>';
    if (McgheeLab.Auth?.currentUser?.uid === _classData.ownerUid) return esc(McgheeLab.Auth.currentUser.email || '(you)');
    return `<code>${esc(_classData.ownerUid)}</code>`;
  })();
  const classAdminEmails = Array.isArray(_classData?.classAdminEmails) ? _classData.classAdminEmails : [];
  const metadataPanel = `
    <section class="cb295-dash-card">
      <header class="cb295-dash-card-header">
        <h3>Class metadata</h3>
        <button type="button" class="btn btn-small btn-secondary" id="cb295-dash-meta-edit">Edit title &amp; dates</button>
      </header>
      <div class="cb295-dash-meta-grid">
        ${metaRow('Title', esc(_classData?.title || '—'))}
        ${metaRow('Subtitle', esc(_classData?.subtitle || '—'))}
        ${metaRow('Semester', esc(_classData?.semester || '—'))}
        ${metaRow('Dates', `${esc(_classData?.startDate || '?')} – ${esc(_classData?.endDate || '?')}`)}
        ${metaRow('Owner UID', ownerEmail)}
        ${metaRow('Class admins', classAdminEmails.length ? classAdminEmails.map(e => `<code>${esc(e)}</code>`).join(' · ') : '<em class="muted-text">none</em>')}
        ${metaRow('Schedule doc updated', _classData?.updatedAt?.toDate ? fmtRelativeTime(_classData.updatedAt) + ' (' + esc(_classData.updatedAt.toDate().toLocaleString()) + ')' : '<em class="muted-text">never</em>')}
        ${metaRow('Roster size', `${roster.length} student${roster.length === 1 ? '' : 's'} (${roster.filter(s => s.campus === 'Tucson').length} Tucson · ${roster.filter(s => s.campus === 'Phoenix').length} Phoenix)`)}
      </div>
      <details class="cb295-dash-inspector">
        <summary>Inspect raw schedule doc</summary>
        <pre class="cb295-dash-pre">${esc(JSON.stringify({
          id: _scheduleId,
          ownerUid: _classData?.ownerUid,
          classAdminEmails,
          title: _classData?.title,
          subtitle: _classData?.subtitle,
          semester: _classData?.semester,
          startDate: _classData?.startDate,
          endDate: _classData?.endDate,
          tabCount: (_classData?.tabs || []).length,
          studentRosterSize: roster.length
        }, null, 2))}</pre>
      </details>
    </section>
  `;

  // V3.251 — completion signals (signed-in / bio / photo / response
  // count) are now folded into the Roster panel rows; no standalone
  // student-grid panel.

  // ── Activity log ──
  const events = [];
  // User profile edits
  for (const [em, p] of profiles.entries()) {
    if (p.bme295c?.updatedAt?.toDate) {
      const rosterMatch = roster.find(r => (r.email || '').toLowerCase() === em);
      const name = rosterMatch ? (rosterMatch.name || em).split(',')[0] : em;
      events.push({
        t: p.bme295c.updatedAt.toDate(),
        kind: 'profile',
        text: `${esc(name)} edited their profile`
      });
    }
  }
  // Group responses
  responses.forEach(r => {
    if (r.lastEditedAt?.toDate) {
      const who = r.lastEditedName || 'someone';
      const sub = r.status === 'submitted' ? 'submitted' : 'edited';
      const speaker = speakers.find(sp => sp.slug === r.speakerSlug);
      const spName = speaker ? speaker.name.split(',')[0] : (r.speakerSlug || '?');
      events.push({
        t: r.lastEditedAt.toDate(),
        kind: 'response',
        text: `${esc(who)} ${sub} <strong>Group ${esc(String(r.groupNumber))}</strong> response on <em>${esc(spName)}</em> (${esc(r.day || '?')}, ${esc(r.campus || '?')})`
      });
    }
  });
  // Schedule edits
  if (_classData?.updatedAt?.toDate) {
    events.push({ t: _classData.updatedAt.toDate(), kind: 'schedule', text: `Schedule doc was edited` });
  }
  events.sort((a, b) => b.t.getTime() - a.t.getTime());
  const topEvents = events.slice(0, 25);
  const activityPanel = `
    <section class="cb295-dash-card">
      <header class="cb295-dash-card-header">
        <h3>Recent activity</h3>
        <span class="muted-text" style="font-size:.8rem;">${loading ? 'Loading…' : `${events.length} event${events.length === 1 ? '' : 's'} on record · showing the latest 25.`}</span>
      </header>
      ${topEvents.length
        ? `<ul class="cb295-dash-activity">${topEvents.map(ev => `
            <li class="cb295-dash-activity-item cb295-dash-activity-${esc(ev.kind)}">
              <span class="cb295-dash-activity-time" title="${esc(ev.t.toLocaleString())}">${esc(fmtRelativeTime(ev.t))}</span>
              <span class="cb295-dash-activity-text">${ev.text}</span>
            </li>
          `).join('')}</ul>`
        : `<p class="muted-text">${loading ? 'Loading activity…' : 'No activity recorded yet. Once students sign in and submit responses, events will appear here.'}</p>`
      }
    </section>
  `;

  return `
    <div class="cb295-dash">
      ${loading ? '<div class="cb295-dash-loading muted-text">Loading dashboard data — pulling user profiles + group responses…</div>' : ''}
      ${metadataPanel}
      ${renderBmeTestModePanel()}
      ${renderBmeClassAdminsPanel()}
      ${renderBmeInstructorsPanel()}
      ${renderBmeSpeakerVideosPanel()}
      ${renderBmeWaitlistPanel()}
      ${renderBmeRosterMgmtPanel()}
      ${renderBmeDailyAttendancePanel()}
      ${renderBmeGradebookPanel()}
      ${renderBmeGradeDiscussionsPanel()}
      ${renderBmeDiscussionGatesPanel()}
      ${renderBmeAssessmentGatePanel()}
      ${renderBmeAssessmentHistogramsPanel()}
      ${renderBmeAssessmentFreetextPanel()}
      ${renderBmeAssessmentSpeakerPanel()}
      ${renderBmeLiveMonitorPanel()}
      ${activityPanel}
    </div>
  `;
}

/** V3.272 — extract a YouTube video id from a pasted URL or a bare
 * 11-character id. Returns null when the input doesn't look like
 * YouTube; the admin panel uses that to surface an inline error.
 * Handles: youtu.be/ID, youtube.com/watch?v=ID, /embed/ID, /v/ID,
 * /shorts/ID, plus a bare 11-char id.
 */
function bmeYoutubeIdFrom(input) {
  if (!input) return null;
  const s = String(input).trim();
  const m =
       s.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|v\/|shorts\/))([\w-]{11})/)
    || s.match(/^([\w-]{11})$/);
  return m ? m[1] : null;
}

/** V3.272 — resolve a speaker's video id from the schedule-doc
 * `speakerVideos` map. Stored values can be URLs or ids; we extract
 * the id at render time so admins can paste whichever form is
 * convenient (and we re-extract every time in case the format changes).
 */
function bmeGetSpeakerVideoId(slug) {
  const raw = _classData?.speakerVideos?.[slug];
  if (!raw) return null;
  return bmeYoutubeIdFrom(raw);
}

/** V3.272 — original input as stored, used for the "↗ Open on YouTube"
 * link in the admin panel + as the value of the URL textbox.
 */
function bmeGetSpeakerVideoRaw(slug) {
  return _classData?.speakerVideos?.[slug] || '';
}

/** V3.261 — return the active instructor list. Schedule-doc overrides
 * (set via the dashboard's edit UI) take precedence over the static
 * `content.json` values. Falls back to content.json so the page renders
 * even before the admin has saved any edits.
 */
function bmeGetInstructors() {
  const overrides = Array.isArray(_classData?.instructors) ? _classData.instructors : null;
  if (overrides && overrides.length) return overrides;
  return _bmeContent?.instructors || [];
}

/** V3.261 — Instructors editing card on the admin dashboard. Each
 * instructor gets editable name/role/department/office/email rows.
 * V3.266 — added profile photo upload + bio textarea so each
 * instructor's identity (photo, bio, contact info) lives in one place
 * on the schedule doc, sourced when the admin signs in.
 *
 * Saving writes the full instructor array back to `_classData.instructors`
 * so the chat sidebar + syllabus + anywhere else reads the new values.
 */
function renderBmeInstructorsPanel() {
  if (_viewType !== 'admin') return '';
  const list = bmeGetInstructors();
  if (!list.length) return '';
  const rows = list.map((inst, idx) => {
    const initial = ((inst.name || '?').replace(/^(Dr\.|Prof\.|Mr\.|Ms\.|Mrs\.)\s+/i, '').charAt(0) || '?').toUpperCase();
    const photoBlock = inst.photoUrl
      ? `<img src="${escAttr(inst.photoUrl)}" alt="${escAttr(inst.name || '')}" />`
      : `<span class="cb295-instructor-photo-placeholder">${esc(initial)}</span>`;
    return `
    <div class="cb295-instructor-edit" data-inst-idx="${idx}">
      <div class="cb295-instructor-edit-photo">
        <div class="cb295-instructor-photo-frame" id="cb295-instructor-photo-${idx}">${photoBlock}</div>
        <label class="btn btn-small btn-secondary cb295-instructor-photo-btn">
          ${inst.photoUrl ? 'Replace photo' : 'Upload photo'}
          <input type="file" class="cb295-instructor-photo-input" data-idx="${idx}" accept="image/*" hidden />
        </label>
        <span class="cb295-instructor-photo-status muted-text" data-idx="${idx}" style="font-size:.75rem;"></span>
      </div>
      <div class="cb295-instructor-edit-fields">
        <div class="form-group">
          <label>Name</label>
          <input type="text" class="cb295-instructor-field" data-field="name" data-idx="${idx}" value="${escAttr(inst.name || '')}" />
        </div>
        <div class="form-group">
          <label>Role</label>
          <input type="text" class="cb295-instructor-field" data-field="role" data-idx="${idx}" value="${escAttr(inst.role || '')}" />
        </div>
        <div class="form-group">
          <label>Department</label>
          <input type="text" class="cb295-instructor-field" data-field="department" data-idx="${idx}" value="${escAttr(inst.department || '')}" />
        </div>
        <div class="form-group">
          <label>Office</label>
          <input type="text" class="cb295-instructor-field" data-field="office" data-idx="${idx}" value="${escAttr(inst.office || '')}" />
        </div>
        <div class="form-group">
          <label>Email</label>
          <input type="email" class="cb295-instructor-field" data-field="email" data-idx="${idx}" value="${escAttr(inst.email || '')}" />
        </div>
        <div class="form-group cb295-instructor-bio-group">
          <label>Bio <span class="muted-text">(shown in chat profile modal + syllabus card)</span></label>
          <textarea class="cb295-instructor-field cb295-instructor-bio" data-field="bio" data-idx="${idx}" rows="3" placeholder="A short bio about yourself for students…">${esc(inst.bio || '')}</textarea>
        </div>
      </div>
    </div>
  `;
  }).join('');
  return `
    <section class="cb295-dash-card" id="cb295-instructors-panel">
      <header class="cb295-dash-card-header">
        <h3>Instructors</h3>
        <span class="muted-text" style="font-size:.8rem;">Photo + bio + contact info for each instructor. Edits land on this schedule doc and override <code>content.json</code> for chat sidebar / syllabus / instructor modal.</span>
      </header>
      ${rows}
      <div class="cb295-instructor-edit-actions">
        <button type="button" class="btn btn-small" id="cb295-instructor-save">Save instructor edits</button>
        <span class="muted-text" id="cb295-instructor-save-status" style="font-size:.8rem;"></span>
      </div>
    </section>
  `;
}

/** V3.272 — Talk videos admin card. Each speaker gets one row to paste
 * a YouTube URL (or bare 11-char id). Saving stamps the value onto
 * `_classData.speakerVideos[slug]`; the modules tab picks it up on
 * next render and shows the embed above the discussion prompts. Empty
 * = no video block renders for students.
 */
function renderBmeSpeakerVideosPanel() {
  if (_viewType !== 'admin') return '';
  const speakers = (_bmeContent?.speakers || []);
  if (!speakers.length) return '';

  const rows = speakers.map(sp => {
    const raw = bmeGetSpeakerVideoRaw(sp.slug);
    const id = bmeGetSpeakerVideoId(sp.slug);
    const hasVideo = !!id;
    const watchUrl = id ? `https://www.youtube.com/watch?v=${id}` : '';
    return `
      <div class="cb295-speaker-video-row" data-speaker-slug="${escAttr(sp.slug)}">
        <div class="cb295-speaker-video-row-head">
          <strong>${esc((sp.name || '').split(',')[0])}</strong>
          <span class="muted-text">${esc(sp.day || '')} · ${esc(sp.time || '')}</span>
          ${hasVideo
            ? `<span class="cb295-speaker-video-pill cb295-speaker-video-pill-yt" title="YouTube embed set">${ICON.svg('play')} YouTube</span>`
            : `<span class="cb295-speaker-video-pill" title="No video set">No video</span>`}
        </div>
        <div class="cb295-speaker-video-row-form">
          <input type="text"
                 class="cb295-speaker-video-input"
                 data-speaker-slug="${escAttr(sp.slug)}"
                 value="${escAttr(raw)}"
                 placeholder="https://youtu.be/… or 11-char video ID" />
          <button type="button" class="btn btn-small cb295-speaker-video-save"
                  data-speaker-slug="${escAttr(sp.slug)}">Save</button>
          ${hasVideo
            ? `<a href="${escAttr(watchUrl)}" target="_blank" rel="noopener" class="cb295-speaker-video-open" title="Open the video in a new tab">↗ Open on YouTube</a>
               <button type="button" class="btn btn-small btn-secondary cb295-speaker-video-remove"
                       data-speaker-slug="${escAttr(sp.slug)}">×</button>`
            : ''}
        </div>
        <p class="muted-text cb295-speaker-video-err" data-speaker-slug="${escAttr(sp.slug)}" style="display:none;font-size:.75rem;margin:.3rem 0 0;color:#ff8a80;">
          Couldn't read a YouTube video ID from that — paste a https://youtu.be/… or https://youtube.com/watch?v=… URL.
        </p>
      </div>
    `;
  }).join('');

  return `
    <section class="cb295-dash-card">
      <header class="cb295-dash-card-header">
        <h3>Talk videos</h3>
        <span class="muted-text" style="font-size:.8rem;">
          Upload each recording to YouTube as <strong>Unlisted</strong>, then paste the link below. Videos render above the discussion prompts on the Modules tab.
        </span>
      </header>
      <p class="cb295-speaker-video-hint">
        ${ICON.svg('light-bulb')} <strong>YouTube embeds are free</strong> — no bandwidth charges no matter how many students watch.
        Make sure the upload is set to <strong>Unlisted</strong> in YouTube Studio so only people with the link can view it.
      </p>
      ${rows}
    </section>
  `;
}

/** V3.796 (was V3.793's "Interested in Summer 2027") — the BME 295C WAITLIST
 * admin card. The lectures page (modules/bme295c/lesson-01.html) writes one
 * `courseWaitlist/{course}_{uid}` entry per signed-in student; this card
 * lists them (Copy emails / CSV / per-row Remove) and is where the list is
 * WRITTEN TO when applications open: "Write to the waitlist" composes a
 * subject + message, opens the admin's own mail app with everyone in BCC
 * (batched at 50 — the site has no mail server, by design), and "Record as
 * sent" stores a courseAnnouncements doc so the card shows what went out and
 * when. Loaded ONCE per page visit by loadBmeWaitlist() (kicked from the
 * dashboard wiring), cached in _bmeWl, re-rendered in place — the dashboard
 * re-renders often and must not re-query on every paint. The compose draft
 * lives in _bmeWl.compose so a repaint never eats a half-written message.
 */
const BME_WL_COURSE = 'bme295c';
const BME_WL_BCC_BATCH = 50;
const _bmeWl = {
  rows: null,          // null = not loaded yet; [] = loaded, empty
  history: [],         // courseAnnouncements, newest first
  error: null,
  compose: null        // { subject, body } while the compose box is open
};

function bmeWlDefaultMessage() {
  return {
    subject: 'BME 295C Summer 2027 — applications are open',
    body: [
      'Hi,',
      '',
      'You asked us to let you know when BME 295C — Challenges in Biomedical Engineering — opens for Summer 2027. Applications are now open.',
      '',
      '[How to apply, the deadline, and the course dates go here.]',
      '',
      'BME 295C is a one-week summer course at the University of Arizona (Tucson and Phoenix campuses) for rising high-school juniors and seniors: two faculty talks each morning, a discussion after each, and a lab tour. Last summer’s lectures are at https://mcgheelab.com/modules/bme295c/lesson-01.html if you’d like a preview.',
      '',
      'Questions? Just reply to this email.',
      '',
      'Dr. Alexander McGhee',
      'Department of Biomedical Engineering, University of Arizona'
    ].join('\n')
  };
}

function renderBmeWaitlistPanel() {
  if (_viewType !== 'admin') return '';
  const rows = _bmeWl.rows;
  const fmtDay = (ts) => {
    const d = ts?.toDate ? ts.toDate() : null;
    return d ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
  };
  const campusLabel = { tucson: 'Tucson', phoenix: 'Phoenix', either: 'Either' };
  const gradLabel = (g) => g === 'other' ? 'Other' : (g || '—');
  let body;
  if (_bmeWl.error) body = `<p class="error-text">Could not load the waitlist: ${esc(_bmeWl.error)}</p>`;
  else if (rows === null) body = '<p class="muted-text">Loading…</p>';
  else if (!rows.length) body = '<p class="muted-text">Nobody yet. Students join at the top of the Summer 2026 lectures page by signing in with Google.</p>';
  else body = `
    <table class="cb295-interest-table">
      <thead><tr><th>Joined</th><th>Name</th><th>Email</th><th>Grad year</th><th>Campus</th><th>Note</th><th></th></tr></thead>
      <tbody>${rows.map(r => `
        <tr data-interest-id="${escAttr(r.id)}">
          <td>${esc(fmtDay(r.createdAt))}</td>
          <td>${esc(r.name || '')}</td>
          <td><a href="mailto:${escAttr(r.email || '')}">${esc(r.email || '')}</a></td>
          <td>${esc(gradLabel(r.gradYear))}</td>
          <td>${esc(campusLabel[r.campus] || r.campus || '—')}</td>
          <td class="cb295-interest-note">${esc(r.note || '')}</td>
          <td><button type="button" class="btn btn-small cb295-interest-remove" data-interest-id="${escAttr(r.id)}">Remove</button></td>
        </tr>`).join('')}
      </tbody>
    </table>`;
  const n = rows ? rows.length : 0;
  const emails = [...new Set((rows || []).map(r => (r.email || '').trim()).filter(Boolean))];

  let compose = '';
  if (_bmeWl.compose && n) {
    const c = _bmeWl.compose;
    const batches = [];
    for (let i = 0; i < emails.length; i += BME_WL_BCC_BATCH) batches.push(emails.slice(i, i + BME_WL_BCC_BATCH));
    const mailto = (list) => 'mailto:?bcc=' + encodeURIComponent(list.join(',')) +
      '&subject=' + encodeURIComponent(c.subject || '') + '&body=' + encodeURIComponent(c.body || '');
    compose = `
      <div class="cb295-wl-compose" id="cb295-wl-compose">
        <label class="cb295-wl-label">Subject
          <input type="text" id="cb295-wl-subject" maxlength="200" value="${escAttr(c.subject || '')}">
        </label>
        <label class="cb295-wl-label">Message
          <textarea id="cb295-wl-body" rows="9" maxlength="5000">${esc(c.body || '')}</textarea>
        </label>
        <p class="muted-text" style="font-size:.8rem;margin:.4rem 0 .5rem;">
          This opens your own mail app with everyone in <strong>BCC</strong> (${emails.length} address${emails.length === 1 ? '' : 'es'}${batches.length > 1 ? `, in ${batches.length} batches of up to ${BME_WL_BCC_BATCH}` : ''}) so students never see each other’s addresses.
          Send it there, then press <strong>Record as sent</strong> so this card remembers it.
        </p>
        <div class="cb295-wl-batches">
          ${batches.map((list, i) => `<a class="btn btn-small" href="${mailto(list)}" data-wl-batch="${i}">${batches.length > 1 ? `Open email · batch ${i + 1} (${list.length})` : `Open email to everyone (${list.length})`}</a>`).join('')}
          <button type="button" class="btn btn-small btn-primary" id="cb295-wl-record">Record as sent</button>
          <button type="button" class="btn btn-small" id="cb295-wl-close">Close</button>
        </div>
      </div>`;
  }

  const history = _bmeWl.history.length ? `
    <details class="cb295-wl-history">
      <summary>Written to ${_bmeWl.history.length} time${_bmeWl.history.length === 1 ? '' : 's'} · last ${esc(fmtDay(_bmeWl.history[0].sentAt))}</summary>
      <ul>${_bmeWl.history.map(h => `<li><strong>${esc(fmtDay(h.sentAt))}</strong> — ${esc(h.subject || '')} <span class="muted-text">(to ${h.recipientCount ?? '?'})</span></li>`).join('')}</ul>
    </details>` : '';

  return `
    <section class="cb295-dash-card" id="cb295-interest-panel">
      <header class="cb295-dash-card-header">
        <h3>BME 295C waitlist — Summer 2027${rows ? ` <span class="muted-text">(${n})</span>` : ''}</h3>
        <span class="muted-text" style="font-size:.8rem;">
          Students join at the top of
          <a href="modules/bme295c/lesson-01.html" target="_blank" rel="noopener">the Summer 2026 lectures page</a>
          by signing in with Google, so every email here is the student’s own. Newest first.
          When applications open, <strong>Write to the waitlist</strong> below.
        </span>
      </header>
      ${body}
      ${n ? `<div class="cb295-interest-actions">
        <button type="button" class="btn btn-small btn-primary" id="cb295-wl-write">${_bmeWl.compose ? 'Writing to the waitlist…' : 'Write to the waitlist'}</button>
        <button type="button" class="btn btn-small" id="cb295-interest-copy">Copy emails</button>
        <button type="button" class="btn btn-small" id="cb295-interest-csv">Download CSV</button>
        <span class="muted-text" id="cb295-interest-status" style="font-size:.8rem;"></span>
      </div>` : ''}
      ${compose}
      ${history}
    </section>`;
}

async function loadBmeWaitlist(force) {
  if (_bmeWl.rows !== null && !force) return;
  const ms = (ts) => ts?.toMillis ? ts.toMillis() : 0;
  try {
    const [wl, ann] = await Promise.all([
      McgheeLab.db.collection('courseWaitlist').where('course', '==', BME_WL_COURSE).get(),
      McgheeLab.db.collection('courseAnnouncements').where('course', '==', BME_WL_COURSE).get()
        .catch(e => { console.warn('[BME295C] courseAnnouncements load failed', e); return { docs: [] }; })
    ]);
    const rows = wl.docs.map(d => ({ id: d.id, ...d.data() }));
    rows.sort((a, b) => ms(b.createdAt) - ms(a.createdAt));
    const history = ann.docs.map(d => ({ id: d.id, ...d.data() }));
    history.sort((a, b) => ms(b.sentAt) - ms(a.sentAt));
    _bmeWl.rows = rows;
    _bmeWl.history = history;
    _bmeWl.error = null;
  } catch (e) {
    console.warn('[BME295C] courseWaitlist load failed', e);
    _bmeWl.error = e.message || String(e);
  }
  repaintBmeWaitlistPanel();
}

function repaintBmeWaitlistPanel() {
  const el = document.getElementById('cb295-interest-panel');
  if (!el) return;
  el.outerHTML = renderBmeWaitlistPanel();
  wireBmeWaitlistPanel();
}

function bmeWaitlistCSV(rows) {
  const q = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const lines = [['joined', 'name', 'email', 'gradYear', 'campus', 'note', 'uid'].join(',')];
  rows.forEach(r => {
    const d = r.createdAt?.toDate ? r.createdAt.toDate().toISOString() : '';
    lines.push([d, r.name, r.email, r.gradYear, r.campus, r.note, r.uid].map(q).join(','));
  });
  return lines.join('\n');
}

function wireBmeWaitlistPanel() {
  const panel = document.getElementById('cb295-interest-panel');
  if (!panel) return;
  const status = panel.querySelector('#cb295-interest-status');
  const say = (msg, sticky) => {
    if (!status) return;
    status.textContent = msg;
    if (!sticky) setTimeout(() => { if (status.textContent === msg) status.textContent = ''; }, 4000);
  };
  panel.querySelector('#cb295-interest-copy')?.addEventListener('click', async () => {
    const emails = [...new Set((_bmeWl.rows || []).map(r => r.email).filter(Boolean))];
    try {
      await navigator.clipboard.writeText(emails.join(', '));
      say(`Copied ${emails.length} email${emails.length === 1 ? '' : 's'}.`);
    } catch (e) { say('Copy failed — select the emails in the table instead.'); }
  });
  panel.querySelector('#cb295-interest-csv')?.addEventListener('click', () => {
    const blob = new Blob([bmeWaitlistCSV(_bmeWl.rows || [])], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'bme295c-summer-2027-waitlist.csv';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 0);
  });

  // Write to the waitlist: open the compose box (draft survives repaints).
  panel.querySelector('#cb295-wl-write')?.addEventListener('click', () => {
    if (!_bmeWl.compose) _bmeWl.compose = bmeWlDefaultMessage();
    repaintBmeWaitlistPanel();
    document.getElementById('cb295-wl-subject')?.focus();
  });
  panel.querySelector('#cb295-wl-subject')?.addEventListener('input', (ev) => { if (_bmeWl.compose) _bmeWl.compose.subject = ev.target.value; });
  panel.querySelector('#cb295-wl-body')?.addEventListener('input', (ev) => { if (_bmeWl.compose) _bmeWl.compose.body = ev.target.value; });
  // The subject/body change the mailto hrefs; rebuild them on blur so the
  // links always carry the text the admin actually typed.
  ['#cb295-wl-subject', '#cb295-wl-body'].forEach(sel => {
    panel.querySelector(sel)?.addEventListener('change', () => repaintBmeWaitlistPanel());
  });
  panel.querySelector('#cb295-wl-close')?.addEventListener('click', () => { _bmeWl.compose = null; repaintBmeWaitlistPanel(); });
  panel.querySelector('#cb295-wl-record')?.addEventListener('click', async (ev) => {
    const btn = ev.currentTarget;
    const c = _bmeWl.compose || {};
    const subject = (c.subject || '').trim();
    if (!subject) { say('Give the email a subject first.', true); document.getElementById('cb295-wl-subject')?.focus(); return; }
    const rows = _bmeWl.rows || [];
    btn.disabled = true;
    try {
      const user = McgheeLab.auth?.currentUser;
      await McgheeLab.db.collection('courseAnnouncements').add({
        course: BME_WL_COURSE,
        subject: subject.slice(0, 200),
        body: (c.body || '').slice(0, 5000),
        recipientCount: rows.length,
        recipientUids: rows.map(r => r.uid).filter(Boolean),
        sentBy: user ? user.uid : '',
        sentAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      _bmeWl.compose = null;
      await loadBmeWaitlist(true);
      const st = document.getElementById('cb295-interest-status');
      if (st) st.textContent = `Recorded: written to ${rows.length} student${rows.length === 1 ? '' : 's'}.`;
    } catch (e) {
      btn.disabled = false;
      say('Could not record it: ' + (e.message || e), true);
    }
  });

  // Remove is a two-click arm (no confirm() popup).
  panel.querySelectorAll('.cb295-interest-remove').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!btn.classList.contains('is-armed')) {
        btn.classList.add('is-armed');
        btn.textContent = 'Sure? Remove';
        setTimeout(() => { if (btn.isConnected) { btn.classList.remove('is-armed'); btn.textContent = 'Remove'; } }, 4000);
        return;
      }
      btn.disabled = true;
      const id = btn.dataset.interestId;
      try {
        await McgheeLab.db.collection('courseWaitlist').doc(id).delete();
        _bmeWl.rows = (_bmeWl.rows || []).filter(r => r.id !== id);
        repaintBmeWaitlistPanel();
      } catch (e) {
        btn.disabled = false;
        say('Could not remove: ' + (e.message || e));
      }
    });
  });
}

/** V3.272 — write a new video link for one speaker. Validates the
 * input via `bmeYoutubeIdFrom`; on failure surfaces the inline error
 * row for that speaker instead of persisting garbage. Empty string =
 * remove.
 */
async function setBmeSpeakerVideo(slug, raw) {
  if (!_classData || !slug) return;
  const trimmed = (raw || '').trim();
  if (trimmed && !bmeYoutubeIdFrom(trimmed)) {
    const err = document.querySelector(`.cb295-speaker-video-err[data-speaker-slug="${slug}"]`);
    if (err) err.style.display = '';
    return;
  }
  const next = { ...(_classData.speakerVideos || {}) };
  if (trimmed) next[slug] = trimmed;
  else delete next[slug];
  _classData.speakerVideos = next;
  markDirty();
  try {
    await persistAll();
  } catch (e) {
    alert('Could not save talk video: ' + (e.message || e));
    return;
  }
  refreshCanvas();
}

/* ─── Live Discussion Monitor (V3.251) ─────────────────────────
   Grid of cells (rows=groups, cols=speakers) per campus. Each cell
   reflects current `groupResponses` doc state: empty/draft/submitted,
   total words, last-edit time, attendance count. Live via the
   onSnapshot in attachBmeDashboardListener.
   ─────────────────────────────────────────────────────────────── */

/** V3.283 — Dedicated "Grade discussions by group" admin panel.
 * Per-speaker `<details>` section; each one lists every (campus, group)
 * combo on the roster with the group's response status + word count +
 * per-response attendance ratio + a 1–3 star picker. Stars are stored
 * at `_classData.grades.discussionQuality[campus-group-slug]` — same
 * key the per-student detail modal reads + writes, so the two surfaces
 * stay in sync. Grade applies to ALL students in that group (the
 * `bmeComputeStudentGrade` discussion path multiplies the credit by
 * stars/3 for every student in the group).
 */
function renderBmeGradeDiscussionsPanel() {
  if (_viewType !== 'admin') return '';
  const speakers = (_bmeContent?.speakers || []);
  const roster = Array.isArray(_classData?.studentRoster) ? _classData.studentRoster : [];
  if (!speakers.length || !roster.length) return '';

  // Build the (campus, group) list from the roster's daily group
  // assignments — same shape as the live monitor's column header
  // (V3.266) so T1..Tn / P1..Pn ordering matches between the two
  // panels.
  const days = bmeCourseDays();
  const collectGroups = (campus) => {
    const set = new Set();
    // V3.284 — bmeStudentCampus, not raw s.campus, so overriding
    // students surface in the campus column their save path uses.
    roster.filter(s => bmeStudentCampus(s) === campus).forEach(s => {
      days.forEach(d => {
        const g = bmeGetGroupForDay(s, d);
        if (typeof g === 'number') set.add(g);
      });
    });
    return [...set].sort((a, b) => a - b);
  };
  const tucson = collectGroups('Tucson').map(g => ({ campus: 'Tucson', group: g, label: 'T' + g }));
  const phoenix = collectGroups('Phoenix').map(g => ({ campus: 'Phoenix', group: g, label: 'P' + g }));
  const allGroups = [...tucson, ...phoenix];
  if (!allGroups.length) {
    return `
      <section class="cb295-dash-card cb295-grade-disc-panel">
        <header class="cb295-dash-card-header">
          <h3>Grade discussions by group</h3>
        </header>
        <p class="muted-text">Run auto-assign on the roster panel first — then grades show up here.</p>
      </section>
    `;
  }

  const today = bmeTodayCourseDay();

  const speakerSections = speakers.map(sp => {
    // V3.284 — drop the `sp.day ||` fallback. `sp.day` is "Monday, June 8"
    // (long form, mismatches dailyGroups keys); always go through
    // bmeSpeakerDay so the date suffix is stripped.
    const day = bmeSpeakerDay(sp.slug);
    const isToday = today && day && day.toLowerCase() === today.toLowerCase();
    // For each (campus, group), look up the response doc + current stars.
    let graded = 0;
    let totalWithResponse = 0;
    const rows = allGroups.map(col => {
      const docId = bmeResponseDocId(col.campus, col.group, sp.slug);
      const r = _bmeDashboardData?.responses?.get(docId);
      const stars = bmeGetDiscussionQuality(col.campus, col.group, sp.slug);
      if (stars) graded += 1;
      if (r) totalWithResponse += 1;
      const submitted = r?.status === 'submitted';
      const draft = r && !submitted;
      const wc = r?.wordCount || 0;
      const presentCount = (r?.attendance?.presentIds || []).length;
      const absentCount = (r?.attendance?.absentIds || []).length;
      const attRatio = (presentCount + absentCount > 0)
        ? `${presentCount}/${presentCount + absentCount} present`
        : '';
      const statusPill = submitted
        ? '<span class="cb295-gradebook-pill cb295-gradebook-pill-ok">' + ICON.svg('check') + ' submitted</span>'
        : draft
          ? '<span class="cb295-gradebook-pill cb295-gradebook-pill-mid">draft</span>'
          : '<span class="cb295-gradebook-pill cb295-gradebook-pill-low">—</span>';
      const campusChipCls = col.campus === 'Tucson' ? 'cb295-grade-disc-label-tucson' : 'cb295-grade-disc-label-phoenix';
      const starButtons = [1, 2, 3].map(s => `<button type="button"
                   class="cb295-gradebook-star${stars === s ? ' cb295-gradebook-star-on' : ''}"
                   data-campus="${escAttr(col.campus)}"
                   data-group="${escAttr(String(col.group))}"
                   data-speaker-slug="${escAttr(sp.slug)}"
                   data-stars="${s}"
                   title="${s}/3 stars">${'★'.repeat(s)}${'☆'.repeat(3 - s)}</button>`).join('');
      const clearBtn = stars
        ? `<button type="button" class="cb295-gradebook-star-clear" data-campus="${escAttr(col.campus)}" data-group="${escAttr(String(col.group))}" data-speaker-slug="${escAttr(sp.slug)}" title="Clear stars (back to ungraded = neutral)">${ICON.svg('x-mark')}</button>`
        : '';
      const viewBtn = r
        ? `<button type="button" class="btn btn-small btn-secondary cb295-grade-disc-view" data-doc-id="${escAttr(docId)}" title="Open the full response">View</button>`
        : '';
      return `
        <div class="cb295-grade-disc-row" data-doc-id="${escAttr(docId)}">
          <span class="cb295-grade-disc-label ${campusChipCls}">${esc(col.label)}</span>
          <span class="cb295-grade-disc-status">${statusPill}</span>
          <span class="cb295-grade-disc-meta muted-text">${esc(`${wc} word${wc === 1 ? '' : 's'}`)}${attRatio ? ' · ' + esc(attRatio) : ''}</span>
          <span class="cb295-grade-disc-stars">${starButtons}${clearBtn}</span>
          ${viewBtn}
        </div>
      `;
    }).join('');

    const summaryCounts = `<span class="muted-text">${graded}/${allGroups.length} graded${totalWithResponse ? ` · ${totalWithResponse} submitted` : ''}</span>`;

    return `
      <details class="cb295-grade-disc-speaker${isToday ? ' cb295-grade-disc-speaker-today' : ''}"${isToday ? ' open' : ''}>
        <summary class="cb295-grade-disc-summary">
          <strong>${esc((sp.name || '').split(',')[0])}</strong>
          <span class="muted-text">${esc(day || '')} · ${esc(sp.time || '')}</span>
          ${summaryCounts}
        </summary>
        <div class="cb295-grade-disc-rows">${rows}</div>
      </details>
    `;
  }).join('');

  return `
    <section class="cb295-dash-card cb295-grade-disc-panel">
      <header class="cb295-dash-card-header">
        <h3>Grade discussions by group</h3>
        <span class="muted-text" style="font-size:.8rem;">
          One row per (group × speaker). Stars apply to <strong>all students in the group</strong> for that talk.
          Ungraded = neutral (counts as full credit). Click <strong>View</strong> to see the full response in a modal.
        </span>
      </header>
      ${speakerSections}
    </section>
  `;
}

function renderBmeLiveMonitorPanel() {
  return `<section class="cb295-dash-card" id="cb295-live-monitor">${bmeLiveMonitorInner()}${renderBmeOrphanedDraftsBlock()}</section>`;
}

/** V3.284 — orphaned drafts surfacing. Every response doc on the
 * schedule has the shape `${campus}-${group}-${slug}`. After the
 * V3.284 routing fixes (Bug 1 day-name + Bug 2 campus override), the
 * docIds students now write to may differ from where pre-V3.284 docs
 * landed. This block walks the snapshot of response docs and lists any
 * doc whose docId doesn't match the docId predicted for ANY current
 * roster student's (bmeStudentCampus × dailyGroup) tuple. Read-only:
 * each row has a "View" button (re-uses the live monitor's read-only
 * modal) + a "Copy text to clipboard" so admin can paste the saved
 * prompts into the correct group's response. NEVER deletes a doc —
 * preserves submitted work in line with the user's V3.284 constraint.
 */
function renderBmeOrphanedDraftsBlock() {
  if (_viewType !== 'admin') return '';
  const dash = _bmeDashboardData;
  if (!dash || !dash.responses) return '';
  const speakers = (_bmeContent?.speakers || []);
  const roster = Array.isArray(_classData?.studentRoster) ? _classData.studentRoster : [];
  if (!speakers.length || !roster.length) return '';

  // Build the set of "expected" docIds — every (bmeStudentCampus,
  // dailyGroup[day], slug) combo a current roster member is part of.
  const expectedIds = new Set();
  const days = bmeCourseDays();
  const slugByDay = new Map();
  speakers.forEach(sp => {
    const d = bmeSpeakerDay(sp.slug);
    if (d) {
      if (!slugByDay.has(d)) slugByDay.set(d, []);
      slugByDay.get(d).push(sp.slug);
    }
  });
  roster.forEach(s => {
    const campus = bmeStudentCampus(s);
    if (!campus) return;
    days.forEach(d => {
      const g = bmeGetGroupForDay(s, d);
      if (typeof g !== 'number') return;
      const slugs = slugByDay.get(d) || [];
      slugs.forEach(slug => expectedIds.add(bmeResponseDocId(campus, g, slug)));
    });
  });

  // Walk dash.responses; any doc id not in expectedIds is orphaned.
  // Sort by status (submitted first — most important to surface).
  const orphans = [];
  dash.responses.forEach(r => {
    if (!r?.id) return;
    if (expectedIds.has(r.id)) return;
    if (r.migratedTo) return; // tombstone from a future migration — skip
    orphans.push(r);
  });
  if (!orphans.length) return '';

  orphans.sort((a, b) => {
    if (a.status === b.status) return 0;
    if (a.status === 'submitted') return -1;
    if (b.status === 'submitted') return 1;
    return 0;
  });

  const rows = orphans.map(r => {
    const submitted = r.status === 'submitted';
    const wc = r.wordCount || 0;
    const editedStr = r.lastEditedAt?.toDate ? fmtRelativeTime(r.lastEditedAt) : '';
    const editedBy = r.lastEditedName ? esc(r.lastEditedName) : '';
    return `
      <div class="cb295-orphan-row" data-doc-id="${escAttr(r.id)}">
        <span class="cb295-orphan-id" title="Firestore docId">${esc(r.id)}</span>
        ${submitted
          ? '<span class="cb295-gradebook-pill cb295-gradebook-pill-ok">' + ICON.svg('check') + ' submitted</span>'
          : '<span class="cb295-gradebook-pill cb295-gradebook-pill-mid">draft</span>'}
        <span class="cb295-orphan-meta muted-text">${wc} word${wc === 1 ? '' : 's'}${editedBy ? ' · by ' + editedBy : ''}${editedStr ? ' · ' + esc(editedStr) : ''}</span>
        <button type="button" class="btn btn-small btn-secondary cb295-orphan-view" data-doc-id="${escAttr(r.id)}">View</button>
        <button type="button" class="btn btn-small btn-secondary cb295-orphan-copy" data-doc-id="${escAttr(r.id)}" title="Copy all 3 prompt responses to clipboard so you can paste into the correct group's response">Copy text</button>
      </div>
    `;
  }).join('');

  return `
    <details class="cb295-orphan-block">
      <summary>
        <strong>${ICON.svg('exclamation-triangle')} Orphaned response docs</strong>
        <span class="muted-text">${orphans.length} doc${orphans.length === 1 ? '' : 's'} at docIds that don't match any current student's (campus × group) — likely pre-V3.284 submissions stranded by the routing bug. Read-only; nothing is deleted.</span>
      </summary>
      <div class="cb295-orphan-rows">${rows}</div>
    </details>
  `;
}

/** V3.269 — Discussion-gates admin card. Lists every speaker with a
 * status pill (pending / open / locked) + Open / Lock / Reset
 * buttons. Top callout highlights "Up next" with a single primary
 * Open button so admin doesn't have to scan the table at class time.
 *
 * Same state writer (`setBmeDiscussionState`) is used by both this
 * card and the per-row toggle on the live monitor, so the two UIs
 * stay in sync.
 */
/** V3.279 — Daily attendance admin card. One section per course day
 * with a checklist of every roster student grouped by campus. Saving
 * just stores the present/absent split; a separate "Assign {Day}'s
 * groups" button runs the single-day rotation against the present
 * students. Today is highlighted by default.
 */
function renderBmeDailyAttendancePanel() {
  if (_viewType !== 'admin') return '';
  const roster = Array.isArray(_classData?.studentRoster) ? _classData.studentRoster : [];
  const days = bmeCourseDays();
  if (!days.length) return '';
  const today = bmeTodayCourseDay();

  // Sort each campus alphabetically by first name for consistent checklist order.
  const tucson = roster.filter(s => s.campus === 'Tucson').slice()
    .sort((a, b) => bmeFirstName(a).localeCompare(bmeFirstName(b)));
  const phoenix = roster.filter(s => s.campus === 'Phoenix').slice()
    .sort((a, b) => bmeFirstName(a).localeCompare(bmeFirstName(b)));

  const daySection = (day) => {
    const att = bmeGetDailyAttendance(day);
    const recorded = !!att;
    const presentIds = new Set(att?.presentIds || []);
    const absentIds = new Set(att?.absentIds || []);
    const isToday = day === today;

    const recordedSummary = recorded
      ? `<span class="cb295-att-status cb295-att-status-recorded">${esc(String((att.presentIds || []).length))} present · ${esc(String((att.absentIds || []).length))} absent${att.recordedAt?.toDate ? ` · ${esc(fmtRelativeTime(att.recordedAt))}` : ''}</span>`
      : '<span class="cb295-att-status cb295-att-status-empty">Not recorded</span>';

    const checklistFor = (members) => members.map(s => {
      // Default-present if no attendance recorded yet; respect saved
      // present/absent when recorded.
      const checked = recorded ? presentIds.has(s.id) : true;
      const explicitlyAbsent = recorded && absentIds.has(s.id);
      // V3.281 — per-(student × day) alertness rating sits inline next to
      // the attendance checkbox so the admin scores engagement in the
      // same moment they confirm who showed up. Three buttons: 1 = not
      // engaged, 2 = partial, 3 = engaged. Disabled when student marked
      // absent (alertness has no meaning for an absent student).
      const alertness = bmeGetAlertness(day, s.id);
      const alertBtn = (r, title) => `
        <button type="button"
                class="cb295-att-alert-btn${alertness === r ? ' cb295-att-alert-btn-active' : ''}"
                data-day="${escAttr(day)}"
                data-student-id="${escAttr(s.id)}"
                data-rating="${r}"
                ${explicitlyAbsent ? 'disabled' : ''}
                title="${esc(title)}">${r}</button>
      `;
      const alertClear = (alertness && !explicitlyAbsent)
        ? `<button type="button" class="cb295-att-alert-clear"
                 data-day="${escAttr(day)}"
                 data-student-id="${escAttr(s.id)}"
                 title="Clear alertness rating">×</button>`
        : '';
      return `
        <div class="cb295-att-student-row${explicitlyAbsent ? ' cb295-att-student-row-absent' : ''}">
          <label class="cb295-att-student">
            <input type="checkbox" class="cb295-att-check"
                   data-day="${escAttr(day)}"
                   data-student-id="${escAttr(s.id)}"
                   ${checked ? 'checked' : ''} />
            <span>${esc(bmeFirstName(s) || (s.name || '').split(',')[0])}</span>
          </label>
          <span class="cb295-att-alert-row" title="Alertness / engagement (1 = not engaged · 2 = partial · 3 = engaged)">
            ${alertBtn(1, 'Not engaged')}
            ${alertBtn(2, 'Partial')}
            ${alertBtn(3, 'Engaged')}
            ${alertClear}
          </span>
        </div>
      `;
    }).join('');

    return `
      <details class="cb295-att-day${isToday ? ' cb295-att-day-today' : ''}" data-day="${escAttr(day)}"${isToday ? ' open' : ''}>
        <summary class="cb295-att-day-summary">
          <span class="cb295-att-day-label">${esc(day)}${isToday ? ' <span class="cb295-att-today-pill">today</span>' : ''}</span>
          ${recordedSummary}
        </summary>
        <div class="cb295-att-day-body">
          <div class="cb295-att-checklist-grid">
            ${tucson.length ? `
              <div class="cb295-att-checklist">
                <h5>Tucson <span class="muted-text">(${tucson.length})</span></h5>
                <div class="cb295-att-students">${checklistFor(tucson)}</div>
              </div>` : ''}
            ${phoenix.length ? `
              <div class="cb295-att-checklist">
                <h5>Phoenix <span class="muted-text">(${phoenix.length})</span></h5>
                <div class="cb295-att-students">${checklistFor(phoenix)}</div>
              </div>` : ''}
          </div>
          <div class="cb295-att-day-actions">
            <button type="button" class="btn btn-small cb295-att-mark-all" data-day="${escAttr(day)}" data-state="all">Mark all present</button>
            <button type="button" class="btn btn-small btn-secondary cb295-att-mark-all" data-day="${escAttr(day)}" data-state="none">Mark all absent</button>
            <span class="cb295-roster-toolbar-sep"></span>
            <button type="button" class="btn btn-small cb295-att-save" data-day="${escAttr(day)}">Save attendance</button>
            <button type="button" class="btn btn-small cb295-att-assign" data-day="${escAttr(day)}" title="Reassign groups for this day using only the checked (present) students">Assign ${esc(day)}'s groups</button>
          </div>
        </div>
      </details>
    `;
  };

  return `
    <section class="cb295-dash-card cb295-att-panel">
      <header class="cb295-dash-card-header">
        <h3>Daily attendance &amp; engagement</h3>
        <span class="muted-text" style="font-size:.8rem;">
          Tick who showed up + rate engagement (1 = not engaged · 2 = partial · 3 = engaged).
          Then click <strong>Assign {Day}'s groups</strong> to rotate only the present students into groups.
          Absent students get no group for that day. Engagement ratings autosave on click and flow into the gradebook composite.
        </span>
      </header>
      ${days.map(daySection).join('')}
    </section>
  `;
}

/** V3.280 — Gradebook admin dashboard card. Per-student row with
 * derived attendance %, derived discussion %, manual alertness %, and
 * a composite total. Click a row to open the per-student detail modal
 * (excused-day toggles, per-talk attendance/response/group-stars/
 * alertness rating, comment textarea). Weight inputs in the header +
 * an Export CSV button. Inline alertness matrix below the table for
 * fast bulk entry without opening 22 modals.
 *
 * Computation: see bmeComputeStudentGrade. Ungraded group quality =
 * neutral (full credit, not zero). Missing attendance for a day = not
 * present for grading (overrides bmeIsPresentOnDay's default-present
 * which is for assignment, not grading). Test rows (TEST_*) filtered.
 */
function renderBmeGradebookPanel() {
  if (_viewType !== 'admin') return '';
  const allRoster = Array.isArray(_classData?.studentRoster) ? _classData.studentRoster : [];
  const roster = allRoster.filter(s => !bmeIsTestRosterEntry(s));
  if (!roster.length) return '';
  const speakers = (_bmeContent?.speakers || []);
  const w = bmeGradeWeights();
  const weightsBad = Math.abs((w._sum || 0) - 100) > 0.5;

  // Per-row data — compute once so the table + inline matrix don't
  // each pay the cost.
  const rowsData = roster
    .map(s => ({ s, g: bmeComputeStudentGrade(s) }))
    .sort((a, b) => b.g.total - a.g.total);

  const pctText = (x) => x == null ? '<span class="muted-text">—</span>' : `${Math.round(x * 100)}%`;
  const totalPill = (t) => {
    const cls = t >= 80 ? 'cb295-gradebook-pill-ok'
              : t >= 60 ? 'cb295-gradebook-pill-mid'
              :           'cb295-gradebook-pill-low';
    return `<span class="cb295-gradebook-pill ${cls}">${t}%</span>`;
  };

  const tableRows = rowsData.map(({ s, g }) => `
    <tr class="cb295-gradebook-row cb295-gradebook-row-clickable" data-student-id="${escAttr(s.id)}">
      <td class="cb295-gradebook-cell-name">${esc((s.name || '').split(',')[0])}</td>
      <td>${pctText(g.att)} <span class="muted-text">${g.presentDays}/${g.countedDays}</span></td>
      <td>${pctText(g.disc)} <span class="muted-text">${g.discDenominator ? '' : '— no group'}</span></td>
      <td>${pctText(g.alert)}</td>
      <td>${totalPill(g.total)}</td>
      <td class="muted-text" style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc((bmeGetStudentComment(s.id) || '').slice(0, 80))}</td>
      <td><button type="button" class="btn btn-small btn-secondary cb295-gradebook-open" data-student-id="${escAttr(s.id)}">Open</button></td>
    </tr>
  `).join('');

  // V3.281 — inline alertness matrix removed; alertness now lives next
  // to the per-day attendance checklist in renderBmeDailyAttendancePanel,
  // so admin scores engagement in the same moment they confirm who
  // showed up. The gradebook panel below is now purely a SUMMARY view +
  // per-student detail modal entry point.
  return `
    <section class="cb295-dash-card cb295-gradebook-panel">
      <header class="cb295-dash-card-header">
        <h3>Gradebook (${roster.length} student${roster.length === 1 ? '' : 's'})</h3>
        <span class="muted-text" style="font-size:.8rem;">
          Attendance + discussion auto-derive from the data above; alertness flows from the per-day engagement rating in the <strong>Daily attendance</strong> panel.
          Test rows (<code>TEST_*</code>) excluded. Click a row to grade discussions + mark excused days.
        </span>
      </header>
      <div class="cb295-gradebook-weights">
        <span class="muted-text">Weights:</span>
        <label>Attendance <input type="number" class="cb295-gradebook-weight-input" data-weight="attendance" min="0" max="100" step="5" value="${esc(String(w._raw?.attendance ?? 40))}" /></label>
        <label>Discussion <input type="number" class="cb295-gradebook-weight-input" data-weight="discussion" min="0" max="100" step="5" value="${esc(String(w._raw?.discussion ?? 30))}" /></label>
        <label>Alertness <input type="number" class="cb295-gradebook-weight-input" data-weight="alertness" min="0" max="100" step="5" value="${esc(String(w._raw?.alertness ?? 30))}" /></label>
        <span class="cb295-gradebook-weight-sum${weightsBad ? ' cb295-gradebook-weight-sum-bad' : ''}" title="Weights are normalized to sum 100 when computing the composite. Red means your raw values don't add to 100; the math still works but consider rounding.">Σ ${Math.round(w._sum || 0)}</span>
        <button type="button" class="btn btn-small cb295-gradebook-export-btn" id="cb295-gradebook-export">Export CSV</button>
      </div>
      <div class="cb295-gradebook-tablewrap">
        <table class="cb295-gradebook-table">
          <thead>
            <tr>
              <th>Student</th><th>Att%</th><th>Disc%</th><th>Alert%</th><th>Total</th><th>Comment</th><th></th>
            </tr>
          </thead>
          <tbody>${tableRows}</tbody>
        </table>
      </div>
    </section>
  `;
}

/** V3.280 — per-student grade detail modal. Mirrors the existing
 * `cb295-modal-overlay` pattern (openBmeMonitorCellModal, openBmeBioModal).
 * Sections:
 *   1. Header: name + email + photo + composite
 *   2. Excused-day grid (5 checkboxes, one per course day)
 *   3. Per-talk rows (10): day · speaker · attendance pill · response
 *      status + word count · group quality 3-star picker · alertness
 *      3-button picker
 *   4. Comment textarea (autosave on blur)
 * Autosave on every change — no Save button. Close re-renders the
 * canvas so the gradebook table picks up new values.
 */
function openBmeStudentGradeModal(rosterId) {
  closeBmeStudentGradeModal();
  const roster = Array.isArray(_classData?.studentRoster) ? _classData.studentRoster : [];
  const student = roster.find(s => s.id === rosterId);
  if (!student) return;
  const days = bmeCourseDays();
  const g = bmeComputeStudentGrade(student);

  const cachedPhoto = _bmeOtherProfileCache?.get(student.id)?.photoUrl
    || _bmeDashboardData?.profilesByEmail?.get((student.email || '').toLowerCase())?.bme295c?.photoUrl
    || '';

  const excusedRow = days.map(d => {
    const checked = bmeIsExcused(student.id, d);
    const present = bmeIsPresentForGrade(student.id, d);
    return `<label class="cb295-gradebook-modal-day">
      <input type="checkbox" class="cb295-gradebook-excused-check" data-student-id="${escAttr(student.id)}" data-day="${escAttr(d)}" ${checked ? 'checked' : ''} />
      <span>${esc(d.slice(0, 3))}</span>
      <span class="muted-text">${present ? '✓ here' : '✗ absent'}</span>
    </label>`;
  }).join('');

  const talkRows = g.perTalk.map(t => {
    const sp = (_bmeContent?.speakers || []).find(s => s.slug === t.slug) || { name: t.slug };
    const respDoc = t.response;
    const respStatus = respDoc?.status === 'submitted'
      ? '<span class="cb295-gradebook-pill cb295-gradebook-pill-ok">' + ICON.svg('check') + ' submitted</span>'
      : respDoc
        ? '<span class="cb295-gradebook-pill cb295-gradebook-pill-mid">draft</span>'
        : '<span class="cb295-gradebook-pill cb295-gradebook-pill-low">—</span>';
    const wordCount = respDoc?.wordCount || 0;
    const credited = t.credited
      ? '<span class="muted-text" title="Counted toward discussion %">credited</span>'
      : '<span class="muted-text" title="Not credited (not submitted or student absent on per-response attendance)">—</span>';
    const groupBadge = t.group
      ? `<span class="muted-text">${esc(t.campus?.charAt(0) || '?')}${esc(String(t.group))}</span>`
      : '<span class="muted-text">no group</span>';

    const starButtons = t.group
      ? [1, 2, 3].map(s => `<button type="button"
                   class="cb295-gradebook-star${t.stars === s ? ' cb295-gradebook-star-on' : ''}"
                   data-campus="${escAttr(t.campus)}"
                   data-group="${escAttr(String(t.group))}"
                   data-speaker-slug="${escAttr(t.slug)}"
                   data-stars="${s}"
                   title="Group quality: ${s}/3">${'★'.repeat(s)}${'☆'.repeat(3 - s)}</button>`).join('')
      : '<span class="muted-text">no group</span>';
    const starClear = (t.stars && t.group)
      ? `<button type="button" class="cb295-gradebook-star-clear" data-campus="${escAttr(t.campus)}" data-group="${escAttr(String(t.group))}" data-speaker-slug="${escAttr(t.slug)}" title="Clear group quality stars (back to ungraded = neutral)">${ICON.svg('x-mark')}</button>`
      : '';

    return `
      <div class="cb295-gradebook-modal-talk" data-speaker-slug="${escAttr(t.slug)}">
        <div class="cb295-gradebook-modal-talk-head">
          <strong>${esc((sp.name || '').split(',')[0])}</strong>
          <span class="muted-text">${esc(t.day || '')}</span>
          ${groupBadge}
        </div>
        <div class="cb295-gradebook-modal-talk-row">
          <div title="Was the student marked present on this talk's day?">
            <span class="muted-text">Attendance:</span> ${bmeIsPresentForGrade(student.id, t.day) ? '<strong style="color:#66d39a;">present</strong>' : t.excused ? '<em>excused</em>' : '<strong style="color:#ff8a80;">absent</strong>'}
          </div>
          <div title="Group response status + word count">
            <span class="muted-text">Response:</span> ${respStatus} <span class="muted-text">${wordCount}w</span> · ${credited}
          </div>
        </div>
        <div class="cb295-gradebook-modal-talk-row">
          <div>
            <span class="muted-text">Group quality (shared):</span>
            <span class="cb295-gradebook-stars">${starButtons}${starClear}</span>
          </div>
        </div>
      </div>
    `;
  }).join('');

  // V3.281 — alertness is now per-day, not per-talk. The block below
  // renders one row per course day with the same 1/2/3 picker the
  // admin uses on the Daily Attendance panel.
  const alertnessRows = (g.perDay || []).map(({ day, rating }) => {
    const present = bmeIsPresentForGrade(student.id, day);
    const excused = bmeIsExcused(student.id, day);
    const buttons = [1, 2, 3].map(r => `<button type="button"
                   class="cb295-gradebook-alert-btn${rating === r ? ' cb295-gradebook-alert-btn-active' : ''}"
                   data-day="${escAttr(day)}"
                   data-student-id="${escAttr(student.id)}"
                   data-rating="${r}"
                   ${(!present && !excused) ? 'disabled' : ''}
                   title="${r === 1 ? 'Not engaged' : r === 2 ? 'Partial' : 'Engaged'}">${r}</button>`).join('');
    const clearBtn = rating
      ? `<button type="button" class="cb295-gradebook-alert-clear" data-day="${escAttr(day)}" data-student-id="${escAttr(student.id)}" title="Clear alertness rating">${ICON.svg('x-mark')}</button>`
      : '';
    return `
      <div class="cb295-gradebook-modal-alert-day">
        <strong>${esc(day)}</strong>
        <span class="muted-text">${present ? '✓ present' : excused ? '<em>excused</em>' : '✗ absent'}</span>
        <span class="cb295-gradebook-alert-btns">${buttons}${clearBtn}</span>
      </div>
    `;
  }).join('');

  const modal = document.createElement('div');
  modal.id = 'cb295-gradebook-modal';
  modal.className = 'cb295-modal-overlay';
  modal.innerHTML = `
    <div class="cb295-modal cb295-gradebook-modal" role="dialog" aria-modal="true" aria-labelledby="cb295-gradebook-modal-title">
      <button type="button" class="cb295-modal-close" id="cb295-gradebook-modal-close" aria-label="Close">&times;</button>
      <header class="cb295-gradebook-modal-header">
        <div class="cb295-gradebook-modal-avatar">
          ${cachedPhoto
            ? `<img src="${esc(cachedPhoto)}" alt="${esc(student.name)}" />`
            : `<div class="cb295-mate-photo cb295-mate-photo-blank">${esc((student.name || '?').charAt(0))}</div>`}
        </div>
        <div>
          <h3 id="cb295-gradebook-modal-title" style="margin:0;">${esc(student.name || '—')}</h3>
          <p class="muted-text" style="margin:.15rem 0;">${esc(student.email || '')} · ${esc(student.campus || '—')}</p>
          <p class="cb295-gradebook-modal-composite">
            <span>Total: <strong>${g.total}%</strong></span>
            <span class="muted-text">Att ${g.att == null ? '—' : Math.round(g.att * 100) + '%'} · Disc ${g.disc == null ? '—' : Math.round(g.disc * 100) + '%'} · Alert ${g.alert == null ? '—' : Math.round(g.alert * 100) + '%'}</span>
          </p>
        </div>
      </header>

      <div class="cb295-modal-body">
        <section>
          <h4>Excused days <span class="muted-text" style="font-weight:400;">(removed from attendance numerator + denominator)</span></h4>
          <div class="cb295-gradebook-modal-excused">${excusedRow}</div>
        </section>

        <section>
          <h4>Daily engagement <span class="muted-text" style="font-weight:400;">(1 = not engaged · 2 = partial · 3 = engaged · also editable on the attendance panel)</span></h4>
          <div class="cb295-gradebook-modal-alertness">${alertnessRows}</div>
        </section>

        <section>
          <h4>Per-talk discussion grades</h4>
          ${talkRows || '<p class="muted-text">No speakers loaded.</p>'}
        </section>

        <section>
          <h4>Admin comment</h4>
          <textarea class="cb295-gradebook-comment"
                    id="cb295-gradebook-comment-input"
                    data-student-id="${escAttr(student.id)}"
                    rows="3"
                    placeholder="Private admin note — not visible to students.">${esc(bmeGetStudentComment(student.id))}</textarea>
        </section>
      </div>

      <div class="cb295-modal-footer">
        <button type="button" class="btn" id="cb295-gradebook-modal-done">Close</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  wireBmeStudentGradeModal(modal);
}

function closeBmeStudentGradeModal() {
  document.getElementById('cb295-gradebook-modal')?.remove();
}

/** Bind handlers inside the per-student detail modal. Autosaves on
 * change — no Save button. */
function wireBmeStudentGradeModal(modal) {
  const close = () => closeBmeStudentGradeModal();
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  document.getElementById('cb295-gradebook-modal-close')?.addEventListener('click', close);
  document.getElementById('cb295-gradebook-modal-done')?.addEventListener('click', close);

  modal.querySelectorAll('.cb295-gradebook-excused-check').forEach(cb => {
    cb.addEventListener('change', () => {
      bmeSetExcused(cb.dataset.studentId, cb.dataset.day, cb.checked);
    });
  });
  modal.querySelectorAll('.cb295-gradebook-star').forEach(btn => {
    btn.addEventListener('click', () => {
      const stars = Number(btn.dataset.stars);
      bmeSetDiscussionQuality(btn.dataset.campus, Number(btn.dataset.group), btn.dataset.speakerSlug, stars);
    });
  });
  modal.querySelectorAll('.cb295-gradebook-star-clear').forEach(btn => {
    btn.addEventListener('click', () => {
      bmeSetDiscussionQuality(btn.dataset.campus, Number(btn.dataset.group), btn.dataset.speakerSlug, null);
    });
  });
  // V3.281 — alertness is per-day now (data-day, not data-speaker-slug).
  modal.querySelectorAll('.cb295-gradebook-alert-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      bmeSetAlertness(btn.dataset.day, btn.dataset.studentId, Number(btn.dataset.rating));
    });
  });
  modal.querySelectorAll('.cb295-gradebook-alert-clear').forEach(btn => {
    btn.addEventListener('click', () => {
      bmeSetAlertness(btn.dataset.day, btn.dataset.studentId, null);
    });
  });
  // Comment: 500 ms debounce on input + flush on blur.
  const commentEl = document.getElementById('cb295-gradebook-comment-input');
  if (commentEl) {
    let timer = null;
    commentEl.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => bmeSetStudentComment(commentEl.dataset.studentId, commentEl.value), 500);
    });
    commentEl.addEventListener('blur', () => {
      clearTimeout(timer);
      bmeSetStudentComment(commentEl.dataset.studentId, commentEl.value);
    });
  }
}

function renderBmeDiscussionGatesPanel() {
  if (_viewType !== 'admin') return '';
  const speakers = (_bmeContent?.speakers || []);
  if (!speakers.length) return '';
  const nextUpSlug = bmeNextPendingSpeakerSlug();
  const nextUpSpeaker = nextUpSlug ? speakers.find(s => s.slug === nextUpSlug) : null;
  const openSlug = bmeAdminOpenSpeakerSlug();
  const openSpeaker = openSlug ? speakers.find(s => s.slug === openSlug) : null;

  const callout = openSpeaker
    ? `<div class="cb295-discgate-callout cb295-discgate-callout-live">
         <span class="cb295-discgate-callout-label">Currently open</span>
         <strong>${esc((openSpeaker.name || '').split(',')[0])}</strong>
         <span class="muted-text">${esc(openSpeaker.day || '')} · ${esc(openSpeaker.time || '')}</span>
         <button type="button" class="btn btn-small cb295-discgate-callout-btn"
                 data-speaker-slug="${escAttr(openSpeaker.slug)}"
                 data-next-state="locked">Lock this discussion</button>
       </div>`
    : nextUpSpeaker
      ? `<div class="cb295-discgate-callout cb295-discgate-callout-nextup">
           <span class="cb295-discgate-callout-label">Up next</span>
           <strong>${esc((nextUpSpeaker.name || '').split(',')[0])}</strong>
           <span class="muted-text">${esc(nextUpSpeaker.day || '')} · ${esc(nextUpSpeaker.time || '')}</span>
           <button type="button" class="btn cb295-discgate-callout-btn"
                   data-speaker-slug="${escAttr(nextUpSpeaker.slug)}"
                   data-next-state="open">Open this discussion</button>
         </div>`
      : `<div class="cb295-discgate-callout cb295-discgate-callout-done">
           <span class="muted-text">All discussions are locked. Click Reset on any row below to re-open one.</span>
         </div>`;

  const rows = speakers.map(sp => {
    const state = bmeGetDiscussionState(sp.slug);
    const isOpen = state === 'open';
    const isLocked = state === 'locked';
    const isPending = state === 'pending';
    const primaryNextState = isPending ? 'open' : isOpen ? 'locked' : 'open';
    const primaryLabel = isPending ? 'Open' : isOpen ? 'Lock' : 'Reopen';
    return `
      <div class="cb295-discgate-row" data-speaker-slug="${escAttr(sp.slug)}" data-state="${esc(state)}">
        <div class="cb295-discgate-row-info">
          <strong>${esc((sp.name || '').split(',')[0])}</strong>
          <span class="muted-text">${esc(sp.day || '')} · ${esc(sp.time || '')} · ${esc(sp.campus || '')}</span>
        </div>
        <span class="cb295-discgate-pill cb295-discgate-pill-${esc(state)}">${esc(state)}</span>
        <div class="cb295-discgate-row-actions">
          <button type="button" class="btn btn-small cb295-discgate-row-btn"
                  data-speaker-slug="${escAttr(sp.slug)}"
                  data-next-state="${esc(primaryNextState)}">${esc(primaryLabel)}</button>
          ${!isPending
            ? `<button type="button" class="btn btn-small btn-secondary cb295-discgate-row-btn"
                       data-speaker-slug="${escAttr(sp.slug)}"
                       data-next-state="pending"
                       title="Return to pending — students see 'discussion not yet released'">Reset</button>`
            : ''}
        </div>
      </div>
    `;
  }).join('');

  return `
    <section class="cb295-dash-card cb295-discgate-panel">
      <header class="cb295-dash-card-header">
        <h3>Discussion gates</h3>
        <span class="muted-text" style="font-size:.8rem;">
          Open after the talk, Lock after discussion. Locked rows are read-only for students.
          Whichever speaker is <em>open</em> also drives the Course Chat header + auto-tag.
        </span>
      </header>
      ${callout}
      <div class="cb295-discgate-rows">${rows}</div>
    </section>
  `;
}

/* ─── V3.286 Course Assessment admin panels ────────────────────
 * Four panels stacked between the discussion gates and the live
 * monitor: (1) gate + summary, (2) course-level histograms,
 * (3) free-text grouped list, (4) per-speaker results table.
 * All gated by `_viewType !== 'admin'`. Read from
 * `_bmeDashboardData.assessments` (Map keyed by uid), populated by
 * `loadBmeDashboardData` + kept live by `attachBmeAssessmentsListener`.
 * ────────────────────────────────────────────────────────── */

function bmeAssessAllDocs() {
  const m = _bmeDashboardData?.assessments;
  return m ? [...m.values()] : [];
}

function renderBmeAssessmentGatePanel() {
  if (_viewType !== 'admin') return '';
  const state = bmeAssessGateState();
  const docs = bmeAssessAllDocs().filter(d => !d.testMode);
  const submitted = docs.filter(d => d.status === 'submitted');
  const drafts = docs.filter(d => d.status !== 'submitted' && hasAnyAssessAnswer(d));
  const roster = Array.isArray(_classData?.studentRoster) ? _classData.studentRoster : [];
  const realRoster = roster.filter(s => !(typeof s.id === 'string' && s.id.startsWith('TEST_')));
  const total = realRoster.length;

  // Per-campus submission breakdown
  const byCampus = (campus) => {
    const sub = submitted.filter(d => (d.campusAtWrite || '') === campus).length;
    const ros = realRoster.filter(s => (s.campus || '') === campus).length;
    return `${sub}/${ros}`;
  };

  const button = (target, label, isPrimary) => `
    <button type="button" class="btn ${isPrimary ? '' : 'btn-secondary'} cb295-assess-gate-btn"
            data-next-state="${escAttr(target)}">${esc(label)}</button>
  `;
  const buttons = state === 'closed'
    ? button('open', 'Open assessment', true)
    : state === 'open'
      ? button('locked', 'Lock assessment', true) + ' ' + button('closed', 'Re-close', false)
      : button('open', 'Re-open', true);

  const statePill = `<span class="cb295-discgate-pill cb295-discgate-pill-${esc(state)}">${esc(state)}</span>`;

  return `
    <section class="cb295-dash-card" id="cb295-assess-gate-panel">
      <header class="cb295-dash-card-header">
        <h3>Course assessment — gate &amp; summary</h3>
        <span class="muted-text" style="font-size:.8rem;">State: ${statePill}</span>
      </header>
      <div class="cb295-assess-gate-row">
        ${buttons}
      </div>
      <div class="cb295-assess-gate-stats">
        <span><strong>${submitted.length}</strong> of ${total} submitted</span>
        <span class="muted-text">· ${drafts.length} drafts</span>
        <span class="muted-text">· Tucson ${byCampus('Tucson')}</span>
        <span class="muted-text">· Phoenix ${byCampus('Phoenix')}</span>
      </div>
      <div class="cb295-assess-gate-actions">
        <button type="button" class="btn btn-small btn-secondary" id="cb295-assess-csv-numeric">Download CSV (numeric)</button>
        <button type="button" class="btn btn-small btn-secondary" id="cb295-assess-csv-text">Download CSV (free-text)</button>
      </div>
    </section>
  `;
}

function hasAnyAssessAnswer(d) {
  if (!d) return false;
  const r = d.ratings || {};
  const p = d.picks || {};
  const t = d.texts || {};
  const s = d.perSpeaker || {};
  return Object.keys(r).length > 0
      || Object.keys(p).length > 0
      || Object.values(t).some(v => (v || '').trim())
      || Object.keys(s).length > 0;
}

function renderBmeAssessmentHistogramsPanel() {
  if (_viewType !== 'admin') return '';
  const docs = bmeAssessAllDocs()
    .filter(d => !d.testMode)
    .filter(d => d.status === 'submitted' || hasAnyAssessAnswer(d));
  if (!docs.length) {
    return `
      <section class="cb295-dash-card">
        <header class="cb295-dash-card-header"><h3>Course-level results</h3></header>
        <p class="muted-text">No responses yet. The histograms will appear here as students submit.</p>
      </section>
    `;
  }

  const rows = BME_ASSESS_COURSE_QS
    .filter(q => q.type === 'stars' || q.type === 'pick')
    .map(q => {
      if (q.type === 'stars') {
        const vals = docs.map(d => d.ratings?.[q.id]).filter(v => typeof v === 'number');
        const n = vals.length;
        const mean = n ? (vals.reduce((a, b) => a + b, 0) / n) : 0;
        const buckets = [1, 2, 3, 4, 5].map(s => vals.filter(v => v === s).length);
        const maxBucket = Math.max(1, ...buckets);
        const bars = [5, 4, 3, 2, 1].map(s => {
          const c = buckets[s - 1];
          const pct = (c / maxBucket) * 100;
          return `
            <div class="cb295-assess-hist-row">
              <span class="cb295-assess-hist-label">${'★'.repeat(s)}${'☆'.repeat(5 - s)}</span>
              <span class="cb295-assess-hist-bar-wrap">
                <span class="cb295-assess-hist-bar" style="width:${pct.toFixed(1)}%"></span>
              </span>
              <span class="cb295-assess-hist-count">${c}</span>
            </div>`;
        }).join('');
        return `
          <details class="cb295-assess-hist-q" open>
            <summary>
              <strong>${esc(q.label)}</strong>
              <span class="muted-text">${n} response${n === 1 ? '' : 's'} · mean ${mean.toFixed(1)}/5</span>
            </summary>
            <div class="cb295-assess-hist">${bars}</div>
          </details>
        `;
      }
      // pick
      const vals = docs.map(d => d.picks?.[q.id]).filter(v => !!v);
      const counts = {};
      q.options.forEach(o => { counts[o.value] = 0; });
      vals.forEach(v => { counts[v] = (counts[v] || 0) + 1; });
      const maxBucket = Math.max(1, ...Object.values(counts));
      const bars = q.options.map(opt => {
        const c = counts[opt.value] || 0;
        const pct = (c / maxBucket) * 100;
        return `
          <div class="cb295-assess-hist-row">
            <span class="cb295-assess-hist-label">${esc(opt.label)}</span>
            <span class="cb295-assess-hist-bar-wrap">
              <span class="cb295-assess-hist-bar" style="width:${pct.toFixed(1)}%"></span>
            </span>
            <span class="cb295-assess-hist-count">${c}</span>
          </div>`;
      }).join('');
      return `
        <details class="cb295-assess-hist-q" open>
          <summary>
            <strong>${esc(q.label)}</strong>
            <span class="muted-text">${vals.length} response${vals.length === 1 ? '' : 's'}</span>
          </summary>
          <div class="cb295-assess-hist">${bars}</div>
        </details>
      `;
    }).join('');

  return `
    <section class="cb295-dash-card">
      <header class="cb295-dash-card-header">
        <h3>Course-level results</h3>
        <span class="muted-text" style="font-size:.8rem;">Aggregated across all submitted + non-empty drafts. Excludes test-mode rows.</span>
      </header>
      ${rows}
    </section>
  `;
}

function renderBmeAssessmentFreetextPanel() {
  if (_viewType !== 'admin') return '';
  const docs = bmeAssessAllDocs().filter(d => !d.testMode);
  const textQs = BME_ASSESS_COURSE_QS.filter(q => q.type === 'text');
  const sections = textQs.map(q => {
    const rows = docs
      .map(d => {
        const txt = ((d.texts || {})[q.id] || '').trim();
        if (!txt) return null;
        const anon = !!d.anonymous;
        const name = anon ? 'anonymous' : (d.lastEditedName || '—');
        const title = anon ? `anonymous (uid ${esc(d.id)} · real name on file: ${esc(d.lastEditedName || '—')})` : esc(d.lastEditedName || '');
        return `
          <div class="cb295-assess-ft-row${anon ? ' cb295-assess-ft-row-anon' : ''}">
            <p class="cb295-assess-ft-text">${esc(txt).replace(/\n/g, '<br>')}</p>
            <p class="cb295-assess-ft-byline muted-text" title="${title}">— ${esc(name)}</p>
          </div>
        `;
      })
      .filter(Boolean)
      .join('');
    if (!rows) return '';
    const n = (rows.match(/cb295-assess-ft-row/g) || []).length;
    return `
      <details class="cb295-assess-ft-q" open>
        <summary>
          <strong>${esc(q.label)}</strong>
          <span class="muted-text">${n} response${n === 1 ? '' : 's'}</span>
        </summary>
        ${rows}
      </details>
    `;
  }).join('');

  if (!sections) {
    return `
      <section class="cb295-dash-card">
        <header class="cb295-dash-card-header"><h3>Open-ended responses</h3></header>
        <p class="muted-text">No free-text responses yet.</p>
      </section>
    `;
  }

  return `
    <section class="cb295-dash-card">
      <header class="cb295-dash-card-header">
        <h3>Open-ended responses</h3>
        <span class="muted-text" style="font-size:.8rem;">Anonymous responses hide the name in the UI; admin tooltip still shows the real name for follow-up.</span>
      </header>
      ${sections}
    </section>
  `;
}

function renderBmeAssessmentSpeakerPanel() {
  if (_viewType !== 'admin') return '';
  const speakers = (_bmeContent?.speakers || []);
  if (!speakers.length) return '';
  const docs = bmeAssessAllDocs().filter(d => !d.testMode);
  if (!docs.length) {
    return `
      <section class="cb295-dash-card">
        <header class="cb295-dash-card-header"><h3>Per-speaker results</h3></header>
        <p class="muted-text">No per-speaker ratings yet.</p>
      </section>
    `;
  }

  const days = bmeCourseDays();
  const grouped = days.map(d => ({
    day: d,
    speakers: speakers.filter(sp => bmeSpeakerDay(sp.slug) === d)
  })).filter(g => g.speakers.length);
  const orphans = speakers.filter(sp => !days.includes(bmeSpeakerDay(sp.slug)));
  if (orphans.length) grouped.push({ day: '', speakers: orphans });

  const renderRow = (sp) => {
    const samples = docs
      .map(d => ({
        stars: d.perSpeaker?.[sp.slug]?.stars,
        comment: (d.perSpeaker?.[sp.slug]?.comment || '').trim(),
        anonymous: !!d.anonymous,
        editedAt: d.lastEditedAt,
        name: d.lastEditedName || '—'
      }))
      .filter(r => typeof r.stars === 'number' || r.comment);
    const ratings = samples.map(r => r.stars).filter(v => typeof v === 'number');
    const n = ratings.length;
    const mean = n ? (ratings.reduce((a, b) => a + b, 0) / n) : 0;
    const meanStars = n
      ? '★'.repeat(Math.round(mean)) + '☆'.repeat(5 - Math.round(mean))
      : '— no ratings';
    const comments = samples.filter(r => r.comment);
    const recent = comments.slice(0, 3);
    const rest = comments.slice(3);
    const commentRow = (r) => `
      <div class="cb295-assess-spk-comment${r.anonymous ? ' cb295-assess-spk-comment-anon' : ''}">
        <p>${esc(r.comment).replace(/\n/g, '<br>')}</p>
        <p class="cb295-assess-spk-comment-by muted-text">— ${esc(r.anonymous ? 'anonymous' : r.name)}</p>
      </div>
    `;
    const restBlock = rest.length ? `
      <details class="cb295-assess-spk-rest">
        <summary class="muted-text">${rest.length} more comment${rest.length === 1 ? '' : 's'}</summary>
        ${rest.map(commentRow).join('')}
      </details>
    ` : '';

    return `
      <div class="cb295-assess-spk-row">
        <div class="cb295-assess-spk-name">
          <strong>${esc((sp.name || '').split(',')[0])}</strong>
        </div>
        <div class="cb295-assess-spk-mean" title="${n} rating${n === 1 ? '' : 's'} · mean ${n ? mean.toFixed(1) : '—'}/5">
          <span class="cb295-assess-spk-stars">${meanStars}</span>
          <span class="muted-text">${n ? mean.toFixed(1) + '/5 · ' + n : ''}</span>
        </div>
        <div class="cb295-assess-spk-comments">
          ${recent.map(commentRow).join('')}
          ${restBlock}
        </div>
      </div>
    `;
  };

  return `
    <section class="cb295-dash-card">
      <header class="cb295-dash-card-header">
        <h3>Per-speaker results</h3>
        <span class="muted-text" style="font-size:.8rem;">Mean star rating + open-ended comments per speaker.</span>
      </header>
      ${grouped.map(g => `
        <div class="cb295-assess-spk-day-group">
          ${g.day ? `<h4 class="cb295-assess-spk-day-head">${esc(g.day)}</h4>` : ''}
          ${g.speakers.map(renderRow).join('')}
        </div>
      `).join('')}
    </section>
  `;
}

/** V3.286 — admin sets _classData.assessmentState. Mirrors
 * setBmeDiscussionState. Persists via persistAll's V3.286 trap.
 */
function setBmeAssessmentState(nextState) {
  if (!_classData) return;
  if (!['closed', 'open', 'locked'].includes(nextState)) return;
  _classData.assessmentState = nextState;
  markDirty();
  persistAll();
  refreshCanvas();
}

/** V3.286 — Numeric CSV: one row per submitted assessment, with
 * columns for each course-level numeric/picked question plus per-speaker
 * stars. Excludes test-mode rows. Anonymous flag IS reflected in a
 * column so admin can filter; the name is replaced with "anonymous"
 * but the row still exists.
 */
function bmeAssessmentsNumericCSV() {
  const docs = bmeAssessAllDocs().filter(d => !d.testMode);
  const speakers = (_bmeContent?.speakers || []);
  const cols = ['uid', 'name', 'anonymous', 'status', 'campus',
                ...BME_ASSESS_COURSE_QS.filter(q => q.type === 'stars').map(q => 'rating_' + q.id),
                ...BME_ASSESS_COURSE_QS.filter(q => q.type === 'pick').map(q => 'pick_' + q.id),
                ...speakers.map(sp => 'speaker_' + sp.slug + '_stars'),
                'submittedAt'];
  const esc = (v) => {
    if (v == null) return '';
    const s = String(v);
    if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  };
  const lines = [cols.join(',')];
  docs.forEach(d => {
    const row = [
      d.id,
      d.anonymous ? 'anonymous' : (d.lastEditedName || ''),
      d.anonymous ? 'yes' : 'no',
      d.status || '',
      d.campusAtWrite || '',
      ...BME_ASSESS_COURSE_QS.filter(q => q.type === 'stars').map(q => d.ratings?.[q.id] ?? ''),
      ...BME_ASSESS_COURSE_QS.filter(q => q.type === 'pick').map(q => d.picks?.[q.id] ?? ''),
      ...speakers.map(sp => d.perSpeaker?.[sp.slug]?.stars ?? ''),
      d.submittedAt?.toDate ? d.submittedAt.toDate().toISOString() : ''
    ].map(esc);
    lines.push(row.join(','));
  });
  return lines.join('\n');
}

/** V3.286 — Free-text CSV: one row per (student × text question +
 * per-speaker comment), so admin can sort/filter in a spreadsheet.
 */
function bmeAssessmentsTextCSV() {
  const docs = bmeAssessAllDocs().filter(d => !d.testMode);
  const speakers = (_bmeContent?.speakers || []);
  const cols = ['uid', 'name', 'anonymous', 'status', 'question_id', 'question_type', 'value'];
  const esc = (v) => {
    if (v == null) return '';
    const s = String(v);
    if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  };
  const lines = [cols.join(',')];
  docs.forEach(d => {
    const name = d.anonymous ? 'anonymous' : (d.lastEditedName || '');
    const anon = d.anonymous ? 'yes' : 'no';
    BME_ASSESS_COURSE_QS.filter(q => q.type === 'text').forEach(q => {
      const v = (d.texts?.[q.id] || '').trim();
      if (!v) return;
      lines.push([d.id, name, anon, d.status || '', q.id, 'course_text', v].map(esc).join(','));
    });
    speakers.forEach(sp => {
      const c = (d.perSpeaker?.[sp.slug]?.comment || '').trim();
      if (!c) return;
      lines.push([d.id, name, anon, d.status || '', sp.slug, 'speaker_comment', c].map(esc).join(','));
    });
  });
  return lines.join('\n');
}

function bmeDownloadAssessmentsCSV(kind) {
  const text = kind === 'numeric' ? bmeAssessmentsNumericCSV() : bmeAssessmentsTextCSV();
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `bme295c-assessment-${kind}.csv`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 0);
}

/** Returns the inner HTML of the live monitor card. Used both for the
 * initial dashboard render and for surgical re-paints from onSnapshot
 * deltas (without blowing away the whole admin canvas).
 */
function bmeLiveMonitorInner() {
  const dash = _bmeDashboardData;
  const speakers = (_bmeContent?.speakers || []);
  const roster = Array.isArray(_classData?.studentRoster) ? _classData.studentRoster : [];
  const days = bmeCourseDays();

  if (!dash) {
    return `
      <header class="cb295-dash-card-header">
        <h3>Live discussion monitor</h3>
        <span class="muted-text" style="font-size:.8rem;">Loading…</span>
      </header>
      <p class="muted-text">Pulling response data…</p>
    `;
  }
  if (!speakers.length) {
    return `
      <header class="cb295-dash-card-header">
        <h3>Live discussion monitor</h3>
      </header>
      <p class="muted-text">content.json hasn't loaded yet.</p>
    `;
  }

  // V3.263 — single unified table:
  //   rows    = speakers (lectures), in schedule order
  //   columns = groups labeled T1, T2, …, Tn, P1, P2, …, Pn
  //             (T = Tucson, P = Phoenix; campus prefix + group number)
  const campusGroups = (campus) => {
    const set = new Set();
    // V3.284 — bmeStudentCampus (not raw s.campus) so an overriding
    // student's group appears under the campus column they actually
    // attend / save responses against.
    roster.filter(s => bmeStudentCampus(s) === campus).forEach(s => {
      days.forEach(d => {
        const g = bmeGetGroupForDay(s, d);
        if (typeof g === 'number') set.add(g);
      });
    });
    return [...set].sort((a, b) => a - b);
  };

  const tucsonGroups = campusGroups('Tucson').map(g => ({ campus: 'Tucson', group: g, label: 'T' + g }));
  const phoenixGroups = campusGroups('Phoenix').map(g => ({ campus: 'Phoenix', group: g, label: 'P' + g }));
  const allCols = [...tucsonGroups, ...phoenixGroups];

  if (!allCols.length) {
    return `
      <header class="cb295-dash-card-header">
        <h3>Live discussion monitor <span class="cb295-live-dot" title="Listening to Firestore">●</span></h3>
        <span class="muted-text" style="font-size:.8rem;">${dash.responses.size} response doc${dash.responses.size === 1 ? '' : 's'} on record.</span>
      </header>
      <p class="muted-text">Run auto-assign to populate groups, then submissions will land here.</p>
    `;
  }

  const renderCell = (campus, group, sp) => {
    const docId = bmeResponseDocId(campus, group, sp.slug);
    const r = dash.responses.get(docId);
    if (!r) {
      return `<td class="cb295-monitor-cell cb295-monitor-cell-empty" data-doc-id="${escAttr(docId)}" title="No response yet">
        <div class="cb295-monitor-cell-inner"><span class="cb295-monitor-status">—</span></div>
      </td>`;
    }
    const statusClass = r.status === 'submitted' ? 'cb295-monitor-cell-submitted' : 'cb295-monitor-cell-draft';
    const editedMs = r.lastEditedAt?.toDate ? r.lastEditedAt.toDate().getTime() : (r.lastEditedAt instanceof Date ? r.lastEditedAt.getTime() : 0);
    const whenStr = editedMs ? fmtRelativeTime(new Date(editedMs)) : '';
    const wc = r.wordCount || 0;
    const attCount = r.attendance
      ? `${r.attendance.presentIds?.length || 0}/${(r.attendance.presentIds?.length || 0) + (r.attendance.absentIds?.length || 0)} present`
      : '';
    return `<td class="cb295-monitor-cell ${statusClass}" data-doc-id="${escAttr(docId)}" title="Click for full response">
      <div class="cb295-monitor-cell-inner">
        <span class="cb295-monitor-words">${wc}w</span>
        <span class="cb295-monitor-status">${r.status === 'submitted' ? '✓ Submitted' : 'Draft'}</span>
        ${attCount ? `<span class="cb295-monitor-attendance">${esc(attCount)}</span>` : ''}
        <span class="cb295-monitor-when" data-edited-ms="${editedMs}">${esc(whenStr)}</span>
      </div>
    </td>`;
  };

  // Header row: Lecture column header + one cell per group (T1…Tn P1…Pn).
  // Insert a thin divider between the Tucson and Phoenix runs so the
  // campuses read as two visual bands.
  const headerCells = allCols.map((col, i) => {
    const prevCampus = i > 0 ? allCols[i - 1].campus : null;
    const showDivider = prevCampus && prevCampus !== col.campus;
    const cls = `cb295-monitor-grouphead cb295-monitor-grouphead-${col.campus.toLowerCase()}${showDivider ? ' cb295-monitor-grouphead-newcampus' : ''}`;
    return `<th class="${cls}" title="${esc(col.campus)} group #${col.group}">${esc(col.label)}</th>`;
  }).join('');

  // V3.269 — inline Open/Lock toggle in each row's header so admin can
  // gate the discussion right where they see the cell coverage.
  const stateButton = (sp) => {
    const state = bmeGetDiscussionState(sp.slug);
    const nextState = state === 'pending' ? 'open'
                    : state === 'open'    ? 'locked'
                    :                       'open';
    const label = state === 'pending' ? 'Open'
                : state === 'open'    ? 'Lock'
                :                       'Reopen';
    return `
      <span class="cb295-discgate-pill cb295-discgate-pill-${esc(state)}" title="${esc(state)}">${esc(state)}</span>
      <button type="button" class="btn btn-small cb295-discgate-row-btn"
              data-speaker-slug="${escAttr(sp.slug)}"
              data-next-state="${esc(nextState)}">${esc(label)}</button>
    `;
  };

  const bodyRows = speakers.map(sp => `
    <tr data-discussion-state="${esc(bmeGetDiscussionState(sp.slug))}">
      <th class="cb295-monitor-rowhead">
        <div class="cb295-monitor-rowhead-body">
          <span class="cb295-monitor-rowhead-day">${esc(sp.day?.slice(0,3) || '')}</span>
          <span class="cb295-monitor-rowhead-name">${esc((sp.name || '').split(',')[0])}</span>
          <span class="cb295-monitor-rowhead-gate">${stateButton(sp)}</span>
        </div>
      </th>
      ${allCols.map((col, i) => {
        const prevCampus = i > 0 ? allCols[i - 1].campus : null;
        const showDivider = prevCampus && prevCampus !== col.campus;
        const td = renderCell(col.campus, col.group, sp);
        return showDivider ? td.replace('class="cb295-monitor-cell', 'class="cb295-monitor-cell cb295-monitor-cell-newcampus') : td;
      }).join('')}
    </tr>
  `).join('');

  return `
    <header class="cb295-dash-card-header">
      <h3>Live discussion monitor <span class="cb295-live-dot" title="Listening to Firestore">●</span></h3>
      <span class="muted-text" style="font-size:.8rem;">
        ${dash.responses.size} response doc${dash.responses.size === 1 ? '' : 's'} on record.
        Rows = lectures · Columns = groups (<strong style="color:#5baed1;">T</strong> Tucson, <strong style="color:#ffd54f;">P</strong> Phoenix). Click any cell to expand.
      </span>
    </header>
    <div class="cb295-dash-tablewrap">
      <table class="cb295-monitor-grid">
        <thead>
          <tr>
            <th class="cb295-monitor-rowhead">Lecture</th>
            ${headerCells}
          </tr>
        </thead>
        <tbody>${bodyRows}</tbody>
      </table>
    </div>
  `;
}

/** Surgical re-paint: swap only the inner HTML of the monitor section
 * (preserves scroll position + any modals the admin has open).
 */
function rerenderBmeLiveMonitor() {
  const root = document.getElementById('cb295-live-monitor');
  if (!root) return;
  root.innerHTML = bmeLiveMonitorInner() + renderBmeOrphanedDraftsBlock();
  wireBmeLiveMonitorCells();
}

function wireBmeLiveMonitorCells() {
  document.querySelectorAll('#cb295-live-monitor .cb295-monitor-cell[data-doc-id]').forEach(cell => {
    cell.addEventListener('click', () => {
      const docId = cell.dataset.docId;
      if (docId) openBmeMonitorCellModal(docId);
    });
  });
  // V3.269 — per-row Open/Lock toggle in the monitor header.
  document.querySelectorAll('#cb295-live-monitor .cb295-discgate-row-btn').forEach(btn => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const slug = btn.dataset.speakerSlug;
      const nextState = btn.dataset.nextState;
      if (slug && nextState) setBmeDiscussionState(slug, nextState);
    });
  });
  // V3.284 — orphan-block buttons (View opens the same read-only modal as
  // a normal cell; Copy text grabs all 3 prompt bodies so the admin can
  // paste into the correct group's response cell, then optionally delete
  // the orphan once recovered).
  document.querySelectorAll('#cb295-live-monitor .cb295-orphan-view').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.docId;
      if (id) openBmeMonitorCellModal(id);
    });
  });
  document.querySelectorAll('#cb295-live-monitor .cb295-orphan-copy').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.docId;
      const r = _bmeDashboardData?.responses?.get(id);
      if (!r) return;
      // V3.284 — slugs can contain dashes (e.g. "Mario_Romero-Ortega"), so
      // `id.split('-').pop()` is wrong. Same suffix-match the modal uses.
      const speakers = (_bmeContent?.speakers || []);
      const speaker = speakers.find(sp => id.endsWith('-' + sp.slug));
      const speakerPrompts = speaker ? ((_bmeContent?.discussion || {})[speaker.slug] || []) : [];
      const lines = speakerPrompts.slice(0, 3).map((p, idx) => {
        const txt = (r.prompts?.[idx] || '').trim();
        return `Prompt ${idx + 1}: ${p?.prompt || ''}\n${txt || '(empty)'}\n`;
      }).join('\n');
      const blob = `${speaker?.name || speakerSlug} — ${r.campus || ''} group ${r.groupNumber || ''}\n` +
                   `Status: ${r.status || ''} · ${r.wordCount || 0} words\n\n${lines}`;
      try {
        await navigator.clipboard.writeText(blob);
        btn.textContent = 'Copied ✓';
        setTimeout(() => { btn.textContent = 'Copy text'; }, 1500);
      } catch (e) {
        alert('Copy failed — ' + (e.message || e));
      }
    });
  });
}

/** Read-only modal showing the full 3-prompt response + attendance
 * roster (admin-only) for a single group/speaker. Reuses the standard
 * cb295-modal-overlay shell.
 */
function openBmeMonitorCellModal(docId) {
  closeBmeMonitorCellModal();
  const dash = _bmeDashboardData;
  if (!dash) return;
  const r = dash.responses.get(docId);
  const speakers = (_bmeContent?.speakers || []);
  const speaker = speakers.find(sp => docId.endsWith('-' + sp.slug));
  const speakerPrompts = speaker ? ((_bmeContent?.discussion || {})[speaker.slug] || []) : [];
  const roster = Array.isArray(_classData?.studentRoster) ? _classData.studentRoster : [];

  const headerBits = [
    speaker ? `<strong>${esc(speaker.name.split(',')[0])}</strong>` : '',
    r?.day ? esc(r.day) : '',
    r?.campus ? esc(r.campus) + ' campus' : '',
    r?.groupNumber ? 'Group #' + esc(String(r.groupNumber)) : ''
  ].filter(Boolean).join(' · ');

  const promptsBlock = r
    ? speakerPrompts.slice(0, 3).map((p, idx) => {
        const txt = (r.prompts?.[idx] || '').trim();
        return `
          <div class="cb295-monitor-modal-prompt">
            <div class="cb295-response-prompt-label">Prompt ${idx + 1}: ${esc(p?.prompt || '')}</div>
            ${txt
              ? `<div class="cb295-response-text">${esc(txt).replace(/\n/g, '<br>')}</div>`
              : '<div class="muted-text">— empty —</div>'}
          </div>
        `;
      }).join('')
    : '<p class="muted-text">No submission yet.</p>';

  let attendanceBlock = '';
  if (r?.attendance) {
    const idToName = new Map(roster.map(s => [s.id, (s.name || s.id).split(',')[0]]));
    const present = (r.attendance.presentIds || []).map(id => idToName.get(id) || id);
    const absent = (r.attendance.absentIds || []).map(id => idToName.get(id) || id);
    const recordedAt = r.attendance.recordedAt?.toDate ? r.attendance.recordedAt.toDate().toLocaleString() : '';
    attendanceBlock = `
      <div class="cb295-monitor-modal-attendance">
        <h4>Attendance</h4>
        <p><strong>Present (${present.length})</strong>: ${present.length ? present.map(esc).join(', ') : '<em class="muted-text">none recorded</em>'}</p>
        <p><strong>Absent (${absent.length})</strong>: ${absent.length ? absent.map(esc).join(', ') : '<em class="muted-text">none</em>'}</p>
        ${recordedAt ? `<p class="muted-text" style="font-size:.8rem;">Recorded ${esc(recordedAt)}</p>` : ''}
      </div>
    `;
  }

  const metaBlock = r ? `
    <p class="muted-text cb295-response-meta" style="margin-top:.5rem;">
      ${esc(r.status === 'submitted' ? 'Submitted' : 'Draft')}
      ${r.lastEditedName ? ' · Last edited by ' + esc(r.lastEditedName) : ''}
      ${r.lastEditedAt?.toDate ? ' · ' + esc(r.lastEditedAt.toDate().toLocaleString()) : ''}
      · ${r.wordCount || 0} words total
    </p>
  ` : '';

  const modal = document.createElement('div');
  modal.id = 'cb295-monitor-cell-modal';
  modal.className = 'cb295-modal-overlay';
  modal.innerHTML = `
    <div class="cb295-modal" role="dialog" aria-modal="true" aria-labelledby="cb295-monitor-modal-title">
      <button type="button" class="cb295-modal-close" id="cb295-monitor-modal-close" aria-label="Close">&times;</button>
      <h3 id="cb295-monitor-modal-title">Group response</h3>
      <p class="muted-text" style="margin:0 0 .75rem;">${headerBits}</p>
      ${promptsBlock}
      ${attendanceBlock}
      ${metaBlock}
      <div class="cb295-modal-footer">
        ${r ? `<button type="button" class="btn btn-secondary cb295-monitor-modal-delete" id="cb295-monitor-modal-delete" data-doc-id="${escAttr(docId)}" title="Delete this response doc — useful for clearing test/stuck submissions before launch">Delete response</button>` : ''}
        <button type="button" class="btn" id="cb295-monitor-modal-done">Done</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  const close = () => closeBmeMonitorCellModal();
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  document.getElementById('cb295-monitor-modal-close')?.addEventListener('click', close);
  document.getElementById('cb295-monitor-modal-done')?.addEventListener('click', close);
  // V3.261 — admin can delete a stuck/test response from inside the
  // modal. Removes the Firestore doc; the live listener fans the change
  // out to the grid so the cell goes back to empty.
  document.getElementById('cb295-monitor-modal-delete')?.addEventListener('click', async () => {
    const id = document.getElementById('cb295-monitor-modal-delete')?.dataset.docId;
    if (!id) return;
    if (!confirm('Delete this response doc? This cannot be undone.')) return;
    try {
      await McgheeLab.db.collection('schedules').doc(_scheduleId)
        .collection('groupResponses').doc(id).delete();
      // Drop from the in-memory cache so the next render picks up the change
      // even before the onSnapshot listener flushes.
      _bmeDashboardData?.responses?.delete(id);
      close();
      if (typeof rerenderBmeLiveMonitor === 'function') rerenderBmeLiveMonitor();
    } catch (e) {
      alert('Delete failed: ' + (e.message || e));
    }
  });
}

function closeBmeMonitorCellModal() {
  document.getElementById('cb295-monitor-cell-modal')?.remove();
}

/* ================================================================
   V3.674 — BME466 HOMEWORK-PROGRESS DASHBOARD (hwDash466)
   Reads hwProgress/{assignment}_{uid} — the docs the homework modules'
   ML-CLOUD-SAVE block autosaves for NetID-signed students. Rules allow
   this list query only for global admins and bme466 classAdminEmails.
   Progress only, never grades (grading stays the D2L JSON upload).
   ================================================================ */
let _hw466Dash = null;   // { assignment, rows|null, error?, loadedAt }
/* V3.675 — class roster lives in schedules/bme466/roster/{email} (staff-only
   subcollection: the parent schedules doc is world-readable, the roster is
   not). Rules gate hwProgress writes on roster membership, so invite/drop
   here IS access control. */
let _hw466Roster = null;  // { rows|null, error?, loadedAt }
async function loadHw466Roster() {
  _hw466Roster = { rows: null };
  try {
    const snap = await McgheeLab.db.collection('schedules').doc('bme466')
      .collection('roster').get();
    const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    rows.sort((a, b) => (a.name || a.email || '').localeCompare(b.name || b.email || ''));
    _hw466Roster = { rows, loadedAt: Date.now() };
  } catch (e) {
    console.warn('[hw466] roster load', e);
    _hw466Roster = { rows: [], error: String(e.message || e) };
  }
  const tab = getActiveTab();
  if (tab?.sections?.some(s => s.key === 'hwDash466')) refreshCanvas();
}
/* minimal CSV parser: quoted fields, embedded commas/newlines, CRLF, BOM */
function hw466ParseCSV(text) {
  const out = []; let row = [], field = '', inQ = false;
  const s = String(text || '').replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQ) {
      if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') out.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.length > 1 || row[0] !== '') out.push(row);
  if (!out.length) return [];
  const head = out[0].map(h => h.trim());
  return out.slice(1).map(r => { const o = {}; head.forEach((h, i) => { o[h] = (r[i] ?? '').trim(); }); return o; });
}
async function hw466ImportRoster(file) {
  let recs;
  try { recs = hw466ParseCSV(await file.text()); }
  catch (e) { alert('Could not read that file: ' + (e.message || e)); return; }
  if (!recs.length || !('Email' in recs[0])) {
    alert('That does not look like a D2L classlist export (no Email column).'); return;
  }
  const students = [], skipped = [];
  recs.forEach(r => {
    const email = (r.Email || '').trim().toLowerCase();
    if (!email || !email.includes('@')) { skipped.push((r.Name || '(no email)')); return; }
    if ((r.Role || 'student').toLowerCase() !== 'student') { skipped.push(`${r.Name || email} (${r.Role})`); return; }
    let name = (r.Name || '').trim();
    const m = name.match(/^([^,]+),\s*(.+)$/);           // D2L "Last, First" → "First Last"
    if (m) name = `${m[2]} ${m[1]}`.trim();
    students.push({ email, name, netid: email.split('@')[0], role: 'student' });
  });
  if (!students.length) { alert('No Student rows found in that file.'); return; }
  if (!confirm(`Invite ${students.length} student(s) from the classlist?\n\nExisting entries with the same email are updated; nobody is auto-dropped (drop individually below). ${skipped.length} non-student/malformed row(s) skipped.`)) return;
  try {
    const col = McgheeLab.db.collection('schedules').doc('bme466').collection('roster');
    let batch = McgheeLab.db.batch(), n = 0;
    for (const s of students) {
      batch.set(col.doc(s.email), { ...s, source: 'csv', addedAt: Date.now() }, { merge: true });
      if (++n % 400 === 0) { await batch.commit(); batch = McgheeLab.db.batch(); }
    }
    await batch.commit();
    // First import turns the roster into an access gate (rules read this
    // flag; until it is true any @arizona.edu account may cloud-save, so an
    // un-imported roster can never lock the class out).
    if (!_classData?.rosterEnforced) {
      try {
        await McgheeLab.db.collection('schedules').doc('bme466').update({ rosterEnforced: true });
        if (_classData) _classData.rosterEnforced = true;
      } catch (e) { console.warn('[hw466] could not enable roster enforcement', e); }
    }
    alert(`Invited/updated ${students.length} student(s).\n\nOnly students on this roster can now save progress.`);
    loadHw466Roster();
  } catch (e) { alert('Import failed: ' + (e.message || e)); }
}
async function hw466SetRosterEnforced(on) {
  if (!on && !confirm('Stop restricting saves to the roster?\n\nAny signed-in @arizona.edu account would then be able to save progress in this class\'s modules.')) return;
  try {
    await McgheeLab.db.collection('schedules').doc('bme466').update({ rosterEnforced: !!on });
    if (_classData) _classData.rosterEnforced = !!on;
    loadHw466Roster();
  } catch (e) { alert('Could not change roster enforcement: ' + (e.message || e)); }
}
/* V3.685 — publish the opt-in classmate directory.
   Students who want to be findable tick a box in their notes panel, which
   writes schedules/bme466/directoryOptIn/{uid}. This materialises those
   into ONE names-only doc that signed-in students may read, so sharing
   notes never needs the roster (instructor-only, FERPA) and never needs a
   `users` query (closed to guests). Nobody who has not opted in appears. */
async function hw466PublishDirectory() {
  const btn = document.getElementById('hw466-dir-publish');
  if (btn) { btn.disabled = true; btn.textContent = 'Publishing…'; }
  try {
    const snap = await McgheeLab.db.collection('schedules').doc('bme466')
      .collection('directoryOptIn').get();
    const people = snap.docs
      .filter(d => d.data().optIn === true)
      .map(d => ({ uid: d.id, name: (d.data().displayName || '').slice(0, 60) }))
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    await McgheeLab.db.collection('schedules').doc('bme466')
      .collection('directory').doc('optedIn')
      .set({ people, count: people.length, updatedAt: Date.now() });
    const note = document.getElementById('hw466-dir-note');
    if (note) note.textContent = `Published — ${people.length} student${people.length === 1 ? '' : 's'} findable.`;
  } catch (e) {
    alert('Could not publish the class directory: ' + (e.message || e));
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Publish class directory'; }
  }
}

async function hw466AddMember(name, email) {
  email = (email || '').trim().toLowerCase();
  if (!/^[^@\s]+@arizona\.edu$/.test(email)) { alert('Enter an @arizona.edu email — cloud saves only accept NetID accounts.'); return; }
  try {
    await McgheeLab.db.collection('schedules').doc('bme466').collection('roster').doc(email)
      .set({ name: (name || '').trim(), email, netid: email.split('@')[0],
             role: 'student', source: 'manual', addedAt: Date.now() }, { merge: true });
    loadHw466Roster();
  } catch (e) { alert('Add failed: ' + (e.message || e)); }
}
async function hw466DropMember(email) {
  const isTA = hw466StaffLists().tas.includes(email);   // V3.681 — narrow TA list
  if (!confirm(`Drop ${email} from the roster?\n\nThis revokes their cloud-save access immediately${isTA ? ' AND removes their TA access' : ''}. Their existing progress docs and exports are untouched.`)) return;
  try {
    if (isTA) await hw466SetTA(email, false, { silent: true });
    await McgheeLab.db.collection('schedules').doc('bme466').collection('roster').doc(email).delete();
    loadHw466Roster();
  } catch (e) { alert('Drop failed: ' + (e.message || e)); }
}
/* V3.681 — TA = an email in schedules/bme466.courseStaffEmails, NOT
   classAdminEmails.
   Until V3.681 this button wrote classAdminEmails, which is the FULL
   instructor view: page-edit chrome, the roster (with every student's name
   and email), and hwProgress delete. V3.679 emptied that list precisely
   because an @arizona.edu address there hands the instructor view to the
   same kind of account a student signs in with — so "assign a user to be a
   TA" had no safe answer. courseStaffEmails is the narrow grant: the
   Assignments & Requests tab (assign homework, status matrix, extensions,
   answer requests, set sections) and nothing else. firestore.rules'
   bme466CourseStaff() is deliberately absent from the roster block, the
   schedule-doc write rule and hwProgress delete; the rules suite asserts
   each of those denials. Promoting someone to full instructor access is a
   deliberate act through classAdminEmails, not a button here. */
async function hw466SetTA(email, makeTA, opts) {
  email = (email || '').trim().toLowerCase();
  if (!email.includes('@')) { alert('Enter the TA\'s full email address.'); return; }
  const staff = (Array.isArray(_classData?.courseStaffEmails) ? _classData.courseStaffEmails : [])
    .map(e => String(e || '').toLowerCase());
  const me = (McgheeLab.Auth?.currentUser?.email || '').toLowerCase();
  if (!makeTA && email === me &&
      !confirm('Remove YOUR OWN TA access? You would lose the Assignments & Requests tab (a global admin can restore it).')) return;
  let next = staff.filter(e => e !== email);
  if (makeTA) next = next.concat([email]);
  try {
    await McgheeLab.db.collection('schedules').doc('bme466').update({ courseStaffEmails: next });
    await McgheeLab.db.collection('schedules').doc('bme466').collection('roster').doc(email)
      .set({ email, netid: email.split('@')[0], role: makeTA ? 'ta' : 'student' }, { merge: true });
    if (_classData) _classData.courseStaffEmails = next;
    if (!opts?.silent) loadHw466Roster(); else return;
  } catch (e) { alert('TA change failed: ' + (e.message || e)); }
}
/** Every address with staff access, and which kind. */
function hw466StaffLists() {
  const lower = a => (Array.isArray(a) ? a : []).map(e => String(e || '').toLowerCase());
  const instructors = lower(_classData?.classAdminEmails);
  const tas = lower(_classData?.courseStaffEmails).filter(e => !instructors.includes(e));
  return { instructors, tas, all: instructors.concat(tas) };
}
const HW466_ASSIGNMENTS = [
  ['bme466-pretest', 'HW0 — Pretest (baseline)'],
  ['bme466-hw1b', 'HW1 — Transport Problems (V2.49)'],
  ['bme466-hw1', 'HW1 v1 — archived, never released'],
  ['bme466-hw2', 'HW2'], ['bme466-hw3', 'HW3'], ['bme466-hw4', 'HW4'],
  ['bme466-hw5', 'HW5'], ['bme466-hw6', 'HW6'], ['bme466-hw7', 'HW7'],
  ['bme466-posttest', 'Post-test (end of semester)']
];
async function loadHw466Dash(assignment) {
  _hw466Dash = { assignment, rows: null };
  try {
    const snap = await McgheeLab.db.collection('hwProgress')
      .where('assignment', '==', assignment).get();
    const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    rows.sort((a, b) => (a.name || a.email || '').localeCompare(b.name || b.email || ''));
    _hw466Dash = { assignment, rows, loadedAt: Date.now() };
  } catch (e) {
    console.warn('[hw466] dashboard load', e);
    _hw466Dash = { assignment, rows: [], error: String(e.message || e) };
  }
  const tab = getActiveTab();
  if (tab?.sections?.some(s => s.key === 'hwDash466')) refreshCanvas();
}
function renderHw466DashBody() {
  if (_viewType !== 'admin') {
    return '<p class="muted-text">This dashboard is only visible to course admins.</p>';
  }
  if (!_hw466Dash) loadHw466Dash('bme466-pretest');   // idempotent kick-off
  const d = _hw466Dash || {};
  const rows = d.rows;
  const options = HW466_ASSIGNMENTS.map(([v, l]) =>
    `<option value="${v}"${v === d.assignment ? ' selected' : ''}>${esc(l)}</option>`).join('');

  let statCards = '', body = '';
  if (!rows) {
    body = '<p class="muted-text">Loading progress docs…</p>';
  } else if (d.error) {
    body = `<p class="muted-text">Could not load hwProgress: ${esc(d.error)} — are you signed in as an admin / class admin?</p>`;
  } else if (!rows.length) {
    body = '<p class="muted-text">No cloud saves for this assignment yet. Students appear here after they sign in with their NetID inside the module.</p>';
  } else {
    const now = Date.now(), DAY = 86400e3;
    const activeToday = rows.filter(r => now - (r.lastActiveAt || 0) < DAY).length;
    const mins = rows.map(r => (r.secondsActive || 0) / 60).sort((a, b) => a - b);
    const median = mins.length ? mins[Math.floor(mins.length / 2)] : 0;
    const done = rows.filter(r => r.totalQuestions && r.answeredCount >= r.totalQuestions).length;
    const meta = (label, val) => `
      <div class="cb295-dash-meta-row">
        <span class="cb295-dash-meta-label">${esc(label)}</span>
        <span class="cb295-dash-meta-val">${val}</span>
      </div>`;
    statCards = `<div class="cb295-dash-meta-grid">
      ${meta('Students saving', String(rows.length))}
      ${meta('Active in the last 24 h', String(activeToday))}
      ${meta('Median active time', median.toFixed(0) + ' min')}
      ${meta('Answered everything', `${done} / ${rows.length}`)}
    </div>`;
    const staffEmails = (Array.isArray(_classData?.classAdminEmails) ? _classData.classAdminEmails : [])
      .map(e => (e || '').toLowerCase());
    const tr = rows.map(r => {
      const total = r.totalQuestions || 0;
      const pct = total ? Math.round(100 * (r.answeredCount || 0) / total) : 0;
      const last = r.lastActiveAt ? fmtRelativeTime(new Date(r.lastActiveAt)) : '—';
      const quiet = r.lastActiveAt && (now - r.lastActiveAt > 7 * DAY);
      const isStaff = staffEmails.includes((r.email || '').toLowerCase());
      return `<tr>
        <td>${esc(r.name || '')}${isStaff ? ' <span class="cb-tab-admin-tag" title="A class admin’s own run — a test, not a student">STAFF TEST</span>' : ''}<br><span class="muted-text" style="font-size:.78em">${esc(r.email || '')}</span></td>
        <td><code>${esc(r.code || '')}</code></td>
        <td style="min-width:150px"><div class="teach-eng-bar"><div class="teach-eng-fill" style="width:${pct}%"></div></div>
            <span class="muted-text" style="font-size:.78em">${r.answeredCount || 0}/${total} (${pct}%)</span></td>
        <td>${((r.secondsActive || 0) / 60).toFixed(0)} min</td>
        <td${quiet ? ' style="color:#b91c1c"' : ''}>${esc(last)}</td>
        <td><button type="button" class="btn btn-small btn-secondary hw466-dash-del" data-doc-id="${esc(r.id)}"
             title="Delete this progress doc (cleanup for test runs)">${ICON.svg('trash')}</button></td>
      </tr>`;
    }).join('');
    body = `<div class="cb295-dash-tablewrap"><table class="cb295-dash-table">
      <thead><tr><th>Student</th><th>Dataset code</th><th>Progress</th><th>Active time</th><th>Last active</th><th></th></tr></thead>
      <tbody>${tr}</tbody></table></div>`;
    /* Who is invited but has not started? The dashboard only ever sees
       students who signed in, so this cross-reference is the real "chase
       list" — and the roster is the only place that knows the denominator. */
    const started = new Set(rows.map(r => (r.email || '').toLowerCase()));
    const notStarted = (_hw466Roster?.rows || [])
      .filter(m => (m.role || 'student') === 'student' && !started.has((m.email || '').toLowerCase()));
    if (notStarted.length) {
      body += `<p class="muted-text" style="margin-top:10px;font-size:.85em">
        <strong>${notStarted.length} invited student(s) have not started:</strong>
        ${notStarted.slice(0, 40).map(m => esc(m.name || m.email)).join(' · ')}${notStarted.length > 40 ? ' …' : ''}</p>`;
    }
  }

  /* ── Roster card (V3.675): invite by CSV, add/drop individually, name TAs.
     Roster membership is what the hwProgress rules check, so this card IS
     the access-control surface — dropping someone revokes cloud saves. */
  if (!_hw466Roster) loadHw466Roster();       // idempotent kick-off
  const R = _hw466Roster || {};
  const SL = hw466StaffLists();               // V3.681 — instructors vs TAs
  let rosterBody = '';
  if (!R.rows) {
    rosterBody = '<p class="muted-text">Loading roster…</p>';
  } else if (R.error) {
    rosterBody = `<p class="muted-text">Could not load the roster: ${esc(R.error)}</p>`;
  } else {
    const roleOf = m => {
      const e = (m.email || m.id || '').toLowerCase();
      return SL.instructors.includes(e) ? 'instructor' : SL.tas.includes(e) ? 'ta' : 'student';
    };
    const staffRows = R.rows.filter(m => roleOf(m) !== 'student');
    const studentRows = R.rows.filter(m => roleOf(m) === 'student');
    const memberRow = (m) => {
      const email = (m.email || m.id || '').toLowerCase();
      const role = roleOf(m);
      const tag = role === 'instructor'
        ? ' <span class="cb-tab-admin-tag" title="Full instructor access (classAdminEmails)">INSTRUCTOR</span>'
        : role === 'ta' ? ' <span class="cb-tab-admin-tag" title="Course staff: assignments, status, requests, sections">TA</span>' : '';
      return `<tr>
        <td>${esc(m.name || '')}${tag}<br>
            <span class="muted-text" style="font-size:.78em">${esc(email)}</span></td>
        <td><code>${esc(m.netid || email.split('@')[0])}</code></td>
        <td>${m.source === 'csv' ? 'classlist' : esc(m.source || 'manual')}</td>
        <td>
          ${role === 'instructor'
            ? '<span class="muted-text" style="font-size:.8em">full access — change via classAdminEmails</span>'
            : `<button type="button" class="btn btn-small btn-secondary hw466-roster-ta"
            data-email="${esc(email)}" data-make="${role === 'ta' ? '0' : '1'}"
            title="${role === 'ta' ? 'Remove TA access' : 'Grant TA access: assign homework, status matrix, extensions, answer requests, set sections. NOT the roster, page editing or progress deletion.'}">${role === 'ta' ? 'Remove TA' : 'Make TA'}</button>`}
          <button type="button" class="btn btn-small btn-secondary hw466-roster-drop"
            data-email="${esc(email)}" title="Drop from the class (revokes cloud saves)">Drop</button>
        </td>
      </tr>`;
    };
    const allRows = staffRows.map(memberRow).concat(studentRows.map(memberRow)).join('');
    const missingStaff = SL.all.filter(a =>
      !R.rows.some(m => (m.email || '').toLowerCase() === a));
    const enforced = !!_classData?.rosterEnforced;
    rosterBody = `
      <div class="cb295-dash-meta-grid">
        <div class="cb295-dash-meta-row"><span class="cb295-dash-meta-label">Students invited</span>
          <span class="cb295-dash-meta-val">${studentRows.length}</span></div>
        <div class="cb295-dash-meta-row"><span class="cb295-dash-meta-label">Instructors / TAs</span>
          <span class="cb295-dash-meta-val">${SL.instructors.length} / ${SL.tas.length}</span></div>
        <div class="cb295-dash-meta-row"><span class="cb295-dash-meta-label">Saves restricted to roster</span>
          <span class="cb295-dash-meta-val">${enforced
            ? '<span class="cb295-dash-yes">✓ yes</span>'
            : '<span class="cb295-dash-no">no — any @arizona.edu account can save</span>'}
            <button type="button" class="btn btn-small btn-secondary" id="hw466-enforce-toggle"
              data-on="${enforced ? '0' : '1'}" style="margin-left:8px">${enforced ? 'Turn off' : 'Turn on'}</button></span></div>
      </div>
      ${missingStaff.length ? `<p class="muted-text" style="font-size:.85em">Staff not listed on the roster (access still works — it comes from
        <code>classAdminEmails</code> / <code>courseStaffEmails</code>): ${missingStaff.map(e => `<code>${esc(e)}</code>`).join(' · ')}</p>` : ''}
      <div class="cb295-dash-tablewrap"><table class="cb295-dash-table">
        <thead><tr><th>Member</th><th>NetID</th><th>Added via</th><th></th></tr></thead>
        <tbody>${allRows || '<tr><td colspan="4" class="muted-text">Nobody on the roster yet — import the D2L classlist above.</td></tr>'}</tbody>
      </table></div>`;
  }
  const rosterPanel = `
    <section class="cb295-dash-card">
      <header class="cb295-dash-card-header">
        <h3>Class roster — invite, drop, assign TAs</h3>
        <span>
          <button type="button" class="btn btn-small btn-primary" id="hw466-roster-import">Import D2L classlist (CSV)</button>
          <input type="file" id="hw466-roster-csv" accept=".csv,text/csv" style="display:none">
          <button type="button" class="btn btn-small btn-secondary" id="hw466-roster-refresh">Refresh</button>
          <button type="button" class="btn btn-small btn-secondary" id="hw466-dir-publish"
                  title="Publish the names of students who ticked &quot;let classmates find me&quot; so classmates can share lecture notes with them">Publish class directory</button>
        </span>
      </header>
      <p class="muted-text" id="hw466-dir-note" style="margin:0 0 8px;font-size:.85em">
        <strong>Class directory (V3.685):</strong> students who tick &ldquo;let classmates find me&rdquo;
        in their notes whiteboard become shareable-with. Press <em>Publish class directory</em> after
        students opt in. Only opted-in students ever appear, and only their display name &mdash;
        the roster itself stays instructor-only. Homework boards are never shareable.
      </p>
      <p class="muted-text" style="margin:4px 0 10px;font-size:.85em">
        Export the classlist from D2L (<em>Classlist → Export</em>) and import it here —
        Student rows become invitations, "Last, First" is flipped, and re-importing
        updates rather than duplicates (nobody is auto-dropped). <strong>Being on this
        roster is what lets a student cloud-save</strong>, so dropping someone revokes
        access immediately (their existing progress docs and any exported file are
        untouched). <strong>Make TA</strong> (V3.681) grants the narrow course-staff role —
        the <em>Assignments &amp; Requests</em> tab: assign homework, see status, grant
        extensions, answer student requests, set sections — by adding the address to
        <code>courseStaffEmails</code>. It deliberately does <strong>not</strong> grant this
        dashboard, this roster, page editing, or progress deletion; those stay with
        <code>classAdminEmails</code>. Works for any <code>@arizona.edu</code> account,
        lab member or not.</p>
      <div class="addrow" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px">
        <input type="text" id="hw466-add-name" class="cb-input" style="width:180px" placeholder="Name (optional)" autocomplete="off">
        <input type="text" id="hw466-add-email" class="cb-input" style="width:230px" placeholder="netid@arizona.edu" autocomplete="off" spellcheck="false">
        <button type="button" class="btn btn-small btn-primary" id="hw466-add-go">Add student</button>
        <span style="width:14px"></span>
        <input type="text" id="hw466-ta-email" class="cb-input" style="width:230px" placeholder="TA's netid@arizona.edu" autocomplete="off" spellcheck="false">
        <button type="button" class="btn btn-small btn-secondary" id="hw466-ta-go">Make TA</button>
      </div>
      ${rosterBody}
    </section>`;

  /* ── Test-an-assignment card: open ANY assignment module, released or not.
     Unpublished only hides a module from the student list — the file itself
     is live, so the instructor can drive it end-to-end before flipping
     "Visible" in Learning Modules. */
  const mods = (Array.isArray(_classData?.modules) ? _classData.modules : [])
    .slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const modRows = mods.map(m => `
    <tr>
      <td>${esc(m.title || m.htmlFile)}${m.kind === 'notes' ? ' <span class="muted-text">(notes)</span>' : ''}<br>
          <span class="muted-text" style="font-size:.78em"><code>${esc(m.htmlFile || '')}</code></span></td>
      <td>${m.published ? '<span class="cb295-dash-yes">✓ released</span>' : '<span class="cb295-dash-no">not released</span>'}</td>
      <td><button type="button" class="btn btn-small btn-secondary hw466-test-open"
           data-folder="${esc(m.folder || 'bme466')}" data-file="${esc(m.htmlFile || '')}">Open &amp; test</button></td>
    </tr>`).join('');
  const testPanel = `
    <section class="cb295-dash-card">
      <header class="cb295-dash-card-header">
        <h3>Test an assignment (works before release)</h3>
        <span><input type="text" id="hw466-test-ds" class="cb-input" style="width:210px"
          placeholder="netid (optional preview)" autocomplete="off" spellcheck="false"
          title="Optional: appended as ?ds=<netid> so the module regenerates that student's seeded numbers (staff preview: exports disabled, no cloud saves). Currently supported by hw-00; harmlessly ignored by modules without it."></span>
      </header>
      <p class="muted-text" style="margin:4px 0 10px;font-size:.85em">
        Opens the module in a new tab whether or not it is released ("not released"
        only hides it from the student list; flip <em>Visible</em> in Learning Modules
        to release). Leave the netid box empty to test as yourself — that run
        autosaves like a student's and shows below tagged <strong>STAFF TEST</strong>;
        delete it with ${ICON.svg('trash')} when you're done. Type a netid to preview that student's
        seeded numbers instead — as a class admin your sign-in carries the preview
        through (previews can't export or cloud-save, so nothing is polluted).</p>
      <div class="cb295-dash-tablewrap"><table class="cb295-dash-table">
        <thead><tr><th>Module</th><th>Status</th><th></th></tr></thead>
        <tbody>${modRows || '<tr><td colspan="3" class="muted-text">No modules on the schedule doc yet.</td></tr>'}</tbody>
      </table></div>
    </section>`;
  return `
    ${rosterPanel}
    ${testPanel}
    <section class="cb295-dash-card">
      <header class="cb295-dash-card-header">
        <h3>Homework progress — cloud saves</h3>
        <span>
          <select id="hw466-dash-assignment" class="cb-input" style="width:auto">${options}</select>
          <button type="button" class="btn btn-small btn-secondary" id="hw466-dash-refresh">Refresh</button>
          <button type="button" class="btn btn-small btn-secondary" id="hw466-dash-csv"${rows && rows.length ? '' : ' disabled'}>CSV</button>
        </span>
      </header>
      <p class="muted-text" style="margin:4px 0 10px;font-size:.85em">
        Autosaved module progress for students who signed in with their UA NetID.
        Progress only — turn-in and grading stay on D2L. Cross-reference the dataset
        code with the keygen CSV on Synology to match D2L uploads.</p>
      ${statCards}
      ${body}
    </section>`;
}
function hw466DashCSV() {
  const d = _hw466Dash;
  if (!d || !Array.isArray(d.rows) || !d.rows.length) return;
  const cols = ['name', 'email', 'sid_norm', 'code', 'answeredCount', 'totalQuestions',
                'runCount', 'secondsActive', 'lastActiveAt', 'clientSavedAt'];
  const cell = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const csv = [cols.join(',')]
    .concat(d.rows.map(r => cols.map(c => cell(r[c])).join(',')))
    .join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${d.assignment}_progress_${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
function wireHw466Dash() {
  document.getElementById('hw466-dash-assignment')?.addEventListener('change', (ev) => {
    loadHw466Dash(ev.target.value);
    refreshCanvas();
  });
  document.getElementById('hw466-dash-refresh')?.addEventListener('click', () => {
    loadHw466Dash(_hw466Dash?.assignment || 'bme466-pretest');
  });
  document.getElementById('hw466-dash-csv')?.addEventListener('click', hw466DashCSV);
  // Test-an-assignment: open the raw module file (released or not), with an
  // optional ?ds=<netid> staff preview of that student's seeded numbers.
  document.querySelectorAll('.hw466-test-open').forEach(btn => {
    btn.addEventListener('click', () => {
      const file = btn.dataset.file;
      if (!file) return;
      const folder = btn.dataset.folder || 'bme466';
      const ds = (document.getElementById('hw466-test-ds')?.value || '').trim();
      const url = `modules/${encodeURIComponent(folder)}/${encodeURIComponent(file)}`
        + (ds ? `?ds=${encodeURIComponent(ds)}` : '');
      window.open(url, '_blank', 'noopener');
    });
  });
  // ── Roster (V3.675): CSV import, individual add/drop, TA assignment ──
  document.getElementById('hw466-roster-import')?.addEventListener('click', () => {
    document.getElementById('hw466-roster-csv')?.click();
  });
  document.getElementById('hw466-roster-csv')?.addEventListener('change', (ev) => {
    const f = ev.target.files && ev.target.files[0];
    ev.target.value = '';                     // allow re-picking the same file
    if (f) hw466ImportRoster(f);
  });
  document.getElementById('hw466-roster-refresh')?.addEventListener('click', () => loadHw466Roster());
  document.getElementById('hw466-dir-publish')?.addEventListener('click', hw466PublishDirectory);
  document.getElementById('hw466-enforce-toggle')?.addEventListener('click', (ev) => {
    hw466SetRosterEnforced(ev.currentTarget.dataset.on === '1');
  });
  const addGo = () => hw466AddMember(
    document.getElementById('hw466-add-name')?.value,
    document.getElementById('hw466-add-email')?.value);
  document.getElementById('hw466-add-go')?.addEventListener('click', addGo);
  document.getElementById('hw466-add-email')?.addEventListener('keydown', e => { if (e.key === 'Enter') addGo(); });
  const taGo = () => {
    const el = document.getElementById('hw466-ta-email');
    if (el?.value) hw466SetTA(el.value, true);
  };
  document.getElementById('hw466-ta-go')?.addEventListener('click', taGo);
  document.getElementById('hw466-ta-email')?.addEventListener('keydown', e => { if (e.key === 'Enter') taGo(); });
  document.querySelectorAll('.hw466-roster-ta').forEach(btn => {
    btn.addEventListener('click', () => hw466SetTA(btn.dataset.email, btn.dataset.make === '1'));
  });
  document.querySelectorAll('.hw466-roster-drop').forEach(btn => {
    btn.addEventListener('click', () => hw466DropMember(btn.dataset.email));
  });
  // Per-row progress-doc delete (test cleanup) — rules allow admin/classAdmin.
  document.querySelectorAll('.hw466-dash-del').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.docId;
      if (!id) return;
      if (!confirm(`Delete the cloud progress doc "${id}"?\n\nThe student's own browser copy and any exported file are untouched — this only clears the cloud save (meant for staff test runs).`)) return;
      try {
        await McgheeLab.db.collection('hwProgress').doc(id).delete();
        loadHw466Dash(_hw466Dash?.assignment || 'bme466-pretest');
      } catch (e) {
        alert('Delete failed: ' + (e.message || e));
      }
    });
  });
}

/* ================================================================
   V3.681 — BME466 COURSE PLATFORM
   Homeworks page · assignment management · student dashboard ·
   private student↔staff requests · course sections.

   Four collections (firestore.rules "V3.681" block):
     schedules/bme466/assignments/{slug}   staff-authored, world-readable
                                           once published
     hw466Status/{slug}_{uid}              self-mark ∪ staff ack/extension
     schedules/bme466/threads/{id}         private request threads
                       …/messages/{id}     immutable
     schedules/bme466/profiles/{uid}       profile + section

   Two rules facts the code must respect:
     • A student may GET but never LIST hwProgress and hw466Status, so the
       student view reads its own docs BY ID. That is why an assignment
       carries `progressKey`.
     • A public list of assignments must carry where('published','==',true)
       or the rule denies the whole query. Ordering is done client-side so
       no composite index is required anywhere in this feature.
   ================================================================ */

/* ── Sections ───────────────────────────────────────────────────
   The four "sections" are the cross-listed catalog lines
   (BME/AME × 466/566), NOT D2L sections 001–004 — the D2L shell merges all
   four into one org unit, which is why the classlist export cannot carry
   them and students must self-declare. */
const HW466_SECTION_CODES = ['BME466', 'AME466', 'BME566', 'AME566'];

/* THE canonical section accessor. Every consumer goes through this — three
   production bugs (V3.272/284/285) came from reading a raw field or falling
   back silently, so there is exactly one place to be wrong.

   Staff assignment WINS over the student's own claim. That is INVERTED
   relative to bmeEffectiveCampus(), where the student's choice wins, and the
   difference is deliberate: a section is registrar truth, not a preference.

   source:'unknown' FAILS OPEN — the student sees every assignment and a
   nudge to tell us their section, and the staff matrix shows "n/a?" and
   drops them from per-level denominators. Silently defaulting to 466 would
   hide a 566-only assignment from a 566 student, which is the worst
   failure available here. */
function bme466Section(profile) {
  const p = profile || {};
  const assigned = HW466_SECTION_CODES.includes(p.sectionAssigned) ? p.sectionAssigned : null;
  const claimed  = HW466_SECTION_CODES.includes(p.sectionClaim)    ? p.sectionClaim    : null;
  const code = assigned || claimed || null;
  if (!code) {
    if (p.sectionAssigned || p.sectionClaim) {
      console.warn('[hw466] unrecognized section value', p.sectionAssigned, p.sectionClaim);
    }
    return { code: null, dept: null, level: null, source: 'unknown' };
  }
  return {
    code,
    dept: code.slice(0, 3),                 // 'BME' | 'AME' — reporting only
    level: code.slice(3),                   // '466' | '566' — the axis that matters
    source: assigned ? 'staff' : 'claim'
  };
}
/** Does this assignment's audience include this student? Unknown → yes. */
function hw466InAudience(assign, sec) {
  const aud = assign?.audience || 'all';
  if (aud === 'all') return true;
  if (!sec || !sec.level) return true;      // fail open
  return sec.level === aud;
}
/** Signed in with a UA NetID (the accounts the homework modules require). */
function bme466SignedInStudent() {
  const em = (McgheeLab.Auth?.currentUser?.email || '').toLowerCase();
  return /@arizona\.edu$/.test(em);
}
function hw466IsStaff() { return _viewType === 'admin' || _isCourseStaff; }
function hw466Db() { return McgheeLab.db; }
function hw466Now() { return firebase.firestore.FieldValue.serverTimestamp(); }
function hw466MyEmail() { return (McgheeLab.Auth?.currentUser?.email || '').toLowerCase(); }
function hw466MyUid() { return McgheeLab.Auth?.currentUser?.uid || ''; }
function hw466Col() { return hw466Db().collection('schedules').doc('bme466'); }
function hw466RepaintIf(keys) {
  const tab = getActiveTab();
  if (tab?.sections?.some(s => keys.includes(s.key))) refreshCanvas();
}
/** YYYY-MM-DD (or '') from an epoch-ms number — dates are stored as ms so
    the record survives a client with a skewed clock being irrelevant. */
function hw466DateStr(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return isNaN(d) ? '' : d.toISOString().slice(0, 10);
}
function hw466ParseDate(s) {
  if (!s) return null;
  const t = Date.parse(s + 'T23:59:00');    // a due date means end of that day
  return isNaN(t) ? null : t;
}

/* ── The F26 assignment inventory (seeded as DRAFTS) ────────────
   Weights and the 566-only markings come from the course repo
   (F26Course/00-admin/COURSE-MAP.md, SEMESTER-PROJECT-DESIGN.md, HW1's
   `[566 only]` parts). Due dates are deliberately absent: D2L is the
   authority and no repo file holds real F26 dates. */
const HW466_SEED_ASSIGNMENTS = [
  { slug: 'hw0-pretest', title: 'HW0 — Pretest (baseline diagnostic)', kind: 'module',
    audience: 'all', order: 0, progressKey: 'bme466-pretest',
    moduleUrl: 'modules/bme466/hw-00-pretest.html',
    notes: 'Ungraded. Completion credit for uploading the export to D2L.' },
  { slug: 'hw1-transport', title: 'HW1 — Transport Problems', kind: 'module',
    audience: 'all', order: 1, progressKey: 'bme466-hw1b',
    moduleUrl: 'modules/bme466/hw-01-transport-problems.html',
    notes: 'Challenge is solved by hand and graded from the PDF (566 only; weight redistributes for 466). V2.49, schema v6. Add bme466-hw1b to schedules/bme466.hwProgressKeys before the first sign-in.' },
  { slug: 'hw2', title: 'HW2 — Reading and Building', kind: 'module', audience: 'all', order: 2, progressKey: 'bme466-hw2',
    moduleUrl: 'modules/bme466/hw-02-reading-and-building.html',
    notes: 'Weeks 3–4. One data tab (the Microscope: receptor, actin, myosin slides), five problems, challenge by hand (566). Released 2026-09-16, due 2026-09-30. V2.79, schema bme466-hw2-v1.' },
  { slug: 'hw3', title: 'HW3 — Grip and Ground', kind: 'module', audience: 'all', order: 3, progressKey: 'bme466-hw3',
    moduleUrl: 'modules/bme466/hw-03-grip-and-ground.html',
    notes: 'Weeks 5–6. No data tab: every given printed per student; three problems × three parts, each joining two relations; challenge by hand (566). Released 2026-10-06, due 2026-10-20. V3.28, schema bme466-hw3-v1.' },
  { slug: 'hw4', title: 'HW4', kind: 'module', audience: 'all', order: 4, progressKey: 'bme466-hw4' },
  { slug: 'hw5', title: 'HW5', kind: 'module', audience: 'all', order: 5, progressKey: 'bme466-hw5' },
  { slug: 'hw6', title: 'HW6', kind: 'module', audience: 'all', order: 6, progressKey: 'bme466-hw6' },
  { slug: 'hw7', title: 'HW7', kind: 'module', audience: 'all', order: 7, progressKey: 'bme466-hw7' },
  { slug: 'report-1', title: 'Report 1 — Read & Rebuild (journal review)', kind: 'report',
    audience: 'all', order: 8, progressKey: 'bme466-report1',
    moduleUrl: 'modules/bme466/report-01-journal-review.html',
    notes: 'Choose ONE of three short papers, then re-derive and re-measure it on your own seeded benches. Turn in TWO files: your written solutions as one PDF, and the results file exported from Tab 3. Out Week 4. Needs nothing past Week 6. V2.82, schema bme466-report1-v1.' },
  { slug: 'midterm', title: 'Midterm exam (covers HW1–4)', kind: 'exam', audience: 'all', order: 9,
    notes: 'Week 9. Separate grad rubric for 566.' },
  { slug: 'report-2', title: 'Report 2 / semester project', kind: 'project', audience: 'all', order: 10,
    notes: 'Teams need at least one 566 student; 566 members own four structural contributions.' },
  { slug: 'bme566-qe', title: 'BME566 qualifying exam', kind: 'qe', audience: '566', order: 11,
    notes: 'Graduate students only.' },
  { slug: 'final', title: 'Final exam', kind: 'exam', audience: 'all', order: 12,
    notes: 'Week 16. Separate grad rubric for 566.' },
  { slug: 'posttest', title: 'Post-test (what you learned)', kind: 'module',
    audience: 'all', order: 13, progressKey: 'bme466-posttest',
    notes: 'Paired with HW0 to measure change over the semester.' }
];
/** Idempotent: writes nothing if any assignment doc already exists. */
async function hw466SeedAssignments() {
  const col = hw466Col().collection('assignments');
  const snap = await col.limit(1).get();
  if (!snap.empty) return false;
  const me = hw466MyEmail();
  let batch = hw466Db().batch(), n = 0;
  for (const a of HW466_SEED_ASSIGNMENTS) {
    batch.set(col.doc(a.slug), {
      ...a, published: false,
      createdAt: hw466Now(), createdBy: me,
      updatedAt: hw466Now(), updatedBy: me
    });
    if (++n % 400 === 0) { await batch.commit(); batch = hw466Db().batch(); }
  }
  await batch.commit();
  // Keep the hwProgress enum in step with what the assignments declare, so
  // adding a homework module never needs a rules redeploy.
  await hw466SyncProgressKeys();
  console.log(`[hw466] seeded ${HW466_SEED_ASSIGNMENTS.length} assignment drafts`);
  return true;
}
/** schedules/bme466.hwProgressKeys ← every progressKey on an assignment. */
async function hw466SyncProgressKeys() {
  try {
    const snap = await hw466Col().collection('assignments').get();
    const keys = [...new Set(snap.docs.map(d => d.data().progressKey).filter(Boolean))];
    if (!keys.length) return;
    await hw466Col().update({ hwProgressKeys: keys });
    if (_classData) _classData.hwProgressKeys = keys;
  } catch (e) { console.warn('[hw466] hwProgressKeys sync failed', e); }
}

/* ── State ────────────────────────────────────────────────────── */
let _hw466Assigns = null;    // { rows|null, error?, loadedAt }
let _hw466Mine    = null;    // { profile, statuses:Map, progress:Map, threads, error? }
let _hw466Staff   = null;    // { profiles, statuses:Map, progress:Map, threads, error? }
let _hw466Thread  = null;    // { id, msgs|null, error? } — the open conversation
let _hw466Editing = null;    // slug being edited, or '__new__', or null
let _hw466Matrix  = null;    // slug the status matrix is showing
let _hw466Compose = false;   // student's "new request" form open?

/* ── Loaders ──────────────────────────────────────────────────── */
async function loadHw466Assigns() {
  _hw466Assigns = { rows: null };
  try {
    /* Staff read every draft; everyone else MUST filter on published or the
       list rule denies the query outright (rules are not filters). */
    const col = hw466Col().collection('assignments');
    const snap = hw466IsStaff() ? await col.get()
                                : await col.where('published', '==', true).get();
    const rows = snap.docs.map(d => ({ slug: d.id, ...d.data() }));
    rows.sort((a, b) => (a.order ?? 99) - (b.order ?? 99)
                     || String(a.slug).localeCompare(String(b.slug)));
    _hw466Assigns = { rows, loadedAt: Date.now() };
  } catch (e) {
    console.warn('[hw466] assignments load', e);
    _hw466Assigns = { rows: [], error: String(e.message || e) };
  }
  hw466RepaintIf(['hwList466', 'hwMine466', 'hwAssign466']);
}

async function loadHw466Mine() {
  const uid = hw466MyUid();
  if (!uid) { _hw466Mine = { error: 'not signed in' }; return; }
  _hw466Mine = { loading: true };
  const out = { profile: null, statuses: new Map(), progress: new Map(), threads: [] };
  try {
    const pSnap = await hw466Col().collection('profiles').doc(uid).get();
    out.profile = pSnap.exists ? pSnap.data() : null;
  } catch (e) { console.warn('[hw466] profile load', e); }
  // Own docs BY ID — a student may get but never list these collections.
  const assigns = (_hw466Assigns?.rows) || [];
  await Promise.all(assigns.map(async (a) => {
    try {
      const s = await hw466Db().collection('hw466Status').doc(`${a.slug}_${uid}`).get();
      if (s.exists) out.statuses.set(a.slug, s.data());
    } catch (e) { /* denied/absent is normal: no doc until they act */ }
    if (a.progressKey) {
      try {
        const p = await hw466Db().collection('hwProgress').doc(`${a.progressKey}_${uid}`).get();
        if (p.exists) out.progress.set(a.slug, p.data());
      } catch (e) { /* same */ }
    }
  }));
  try {
    const tSnap = await hw466Col().collection('threads').where('authorUid', '==', uid).get();
    out.threads = tSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    out.threads.sort((a, b) => hw466Ms(b.lastMessageAt || b.createdAt) - hw466Ms(a.lastMessageAt || a.createdAt));
  } catch (e) { console.warn('[hw466] my threads', e); }
  _hw466Mine = out;
  hw466RepaintIf(['hwMine466']);
}

async function loadHw466Staff() {
  _hw466Staff = { loading: true };
  const out = { profiles: [], statuses: new Map(), progress: new Map(), threads: [], errors: [] };
  try {
    const snap = await hw466Col().collection('profiles').get();
    out.profiles = snap.docs.map(d => ({ uid: d.id, ...d.data() }));
  } catch (e) { out.errors.push('profiles: ' + (e.message || e)); }
  try {
    const snap = await hw466Col().collection('threads').get();
    out.threads = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    out.threads.sort((a, b) => (b.unreadForStaff ? 1 : 0) - (a.unreadForStaff ? 1 : 0)
      || hw466Ms(b.lastMessageAt || b.createdAt) - hw466Ms(a.lastMessageAt || a.createdAt));
  } catch (e) { out.errors.push('threads: ' + (e.message || e)); }
  const slug = _hw466Matrix;
  if (slug) {
    try {
      const snap = await hw466Db().collection('hw466Status').where('assignment', '==', slug).get();
      snap.docs.forEach(d => out.statuses.set(d.data().uid, d.data()));
    } catch (e) { out.errors.push('status: ' + (e.message || e)); }
    const a = (_hw466Assigns?.rows || []).find(x => x.slug === slug);
    if (a?.progressKey) {
      try {
        const snap = await hw466Db().collection('hwProgress')
          .where('assignment', '==', a.progressKey).get();
        snap.docs.forEach(d => {
          const v = d.data();
          // hwProgress is keyed by uid in the docId, not by a uid field.
          out.progress.set(String(d.id).split('_').slice(1).join('_'), v);
        });
      } catch (e) { out.errors.push('progress: ' + (e.message || e)); }
    }
  }
  _hw466Staff = out;
  hw466RepaintIf(['hwAssign466']);
}

/** Firestore Timestamp | number | undefined → ms (0 when unknown). */
/* V3.684 — a module opened OUTSIDE the viewer (these links, and any
   direct link) still needs its class context for the whiteboard panel,
   which the iframe now gets from its src. Appends, never clobbers, an
   existing query string. */
function hw466ModuleHref(url, classId) {
  if (!url) return url;
  if (/[?&]class=/.test(url)) return url;
  return url + (url.includes('?') ? '&' : '?') + 'class=' + encodeURIComponent(classId || 'bme466');
}

function hw466Ms(v) {
  if (!v) return 0;
  if (typeof v === 'number') return v;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (v.seconds) return v.seconds * 1000;
  return 0;
}

async function loadHw466Thread(id) {
  _hw466Thread = { id, msgs: null };
  try {
    const snap = await hw466Col().collection('threads').doc(id)
      .collection('messages').get();
    const msgs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    msgs.sort((a, b) => hw466Ms(a.createdAt) - hw466Ms(b.createdAt));
    _hw466Thread = { id, msgs };
    // Clear MY unread flag (each side may only clear its own).
    const side = hw466IsStaff() ? { unreadForStaff: false } : { unreadForAuthor: false };
    try { await hw466Col().collection('threads').doc(id).update({ ...side, updatedAt: hw466Now() }); }
    catch (e) { /* not fatal: the badge just stays until next time */ }
  } catch (e) {
    _hw466Thread = { id, msgs: [], error: String(e.message || e) };
  }
  hw466RepaintIf(['hwMine466', 'hwAssign466']);
}

/* ── Writers ──────────────────────────────────────────────────── */
async function hw466SaveAssignment(vals) {
  const slug = String(vals.slug || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,59}$/.test(slug)) {
    alert('The id must be lowercase letters, digits and hyphens (no underscores or spaces) — it becomes part of the document id.');
    return;
  }
  if (!vals.title.trim()) { alert('Give the assignment a title.'); return; }
  const doc = {
    slug, title: vals.title.trim(), kind: vals.kind, audience: vals.audience,
    published: !!vals.published, order: Number(vals.order) || 0,
    updatedAt: hw466Now(), updatedBy: hw466MyEmail()
  };
  // Only send optional fields that have a value: the rules whitelist allows
  // them but a blank string is noise on a world-readable doc.
  ['moduleUrl', 'd2lLink', 'notes', 'progressKey'].forEach(k => {
    const v = String(vals[k] || '').trim();
    if (v) doc[k] = v;
  });
  const due = hw466ParseDate(vals.dueAt);
  if (due) doc.dueAt = due;
  const opens = hw466ParseDate(vals.opensAt);
  if (opens) doc.opensAt = opens;
  try {
    const ref = hw466Col().collection('assignments').doc(slug);
    const existing = await ref.get();
    if (!existing.exists) { doc.createdAt = hw466Now(); doc.createdBy = hw466MyEmail(); }
    await ref.set(doc, { merge: true });
    _hw466Editing = null;
    if (doc.progressKey) await hw466SyncProgressKeys();
    await loadHw466Assigns();
  } catch (e) { alert('Save failed: ' + (e.message || e)); }
}
async function hw466TogglePublish(slug, on) {
  if (on && !confirm(`Publish "${slug}"?\n\nIt becomes visible on the public Homeworks page, and every student it is for gets a notification.`)) return;
  try {
    await hw466Col().collection('assignments').doc(slug)
      .set({ published: !!on, updatedAt: hw466Now(), updatedBy: hw466MyEmail() }, { merge: true });
    await loadHw466Assigns();
  } catch (e) { alert('Could not change release state: ' + (e.message || e)); }
}
async function hw466DeleteAssignment(slug) {
  if (!confirm(`Delete the assignment record "${slug}"?\n\nStudent self-marks and staff notes for it are left behind (they live in hw466Status). Unpublishing is usually what you want instead.`)) return;
  try {
    await hw466Col().collection('assignments').doc(slug).delete();
    await loadHw466Assigns();
  } catch (e) { alert('Delete failed: ' + (e.message || e)); }
}
async function hw466SaveProfile(vals) {
  const uid = hw466MyUid();
  if (!uid) return;
  const doc = {
    uid, email: hw466MyEmail(),
    displayName: String(vals.displayName || '').slice(0, 120),
    pronouns: String(vals.pronouns || '').slice(0, 40),
    major: String(vals.major || '').slice(0, 80),
    year: String(vals.year || '').slice(0, 40),
    interests: String(vals.interests || '').slice(0, 1000),
    contactPref: String(vals.contactPref || '').slice(0, 40),
    sectionClaim: HW466_SECTION_CODES.includes(vals.sectionClaim) ? vals.sectionClaim : null,
    updatedAt: hw466Now()
  };
  try {
    const ref = hw466Col().collection('profiles').doc(uid);
    const existing = await ref.get();
    if (!existing.exists) doc.createdAt = hw466Now();
    await ref.set(doc, { merge: true });
    await loadHw466Mine();
  } catch (e) { alert('Could not save your profile: ' + (e.message || e)); }
}
/* The student's own "I uploaded it to D2L" mark. NOT a grade and not a
   submission — D2L remains the turn-in and the gradebook; this is what makes
   the pending/completed split honest without one. */
async function hw466SelfMark(slug, on, note) {
  const uid = hw466MyUid();
  if (!uid) return;
  const body = {
    assignment: slug, uid, email: hw466MyEmail(),
    name: (_hw466Mine?.profile?.displayName) || (McgheeLab.Auth?.currentUser?.displayName || ''),
    selfMarked: !!on, selfMarkedAt: on ? Date.now() : null,
    updatedAt: hw466Now()
  };
  if (typeof note === 'string') body.note = note.slice(0, 500);
  try {
    const ref = hw466Db().collection('hw466Status').doc(`${slug}_${uid}`);
    const existing = await ref.get();
    if (!existing.exists) body.createdAt = hw466Now();
    await ref.set(body, { merge: true });
    await loadHw466Mine();
  } catch (e) { alert('Could not record that: ' + (e.message || e)); }
}
async function hw466Ack(slug, uid, on) {
  try {
    const ref = hw466Db().collection('hw466Status').doc(`${slug}_${uid}`);
    const existing = await ref.get();
    const body = on
      ? { ackBy: hw466MyEmail(), ackAt: Date.now(), updatedAt: hw466Now() }
      : { ackBy: null, ackAt: null, updatedAt: hw466Now() };
    if (!existing.exists) { body.assignment = slug; body.uid = uid; body.createdAt = hw466Now(); }
    await ref.set(body, { merge: true });
    await loadHw466Staff();
  } catch (e) { alert('Could not acknowledge: ' + (e.message || e)); }
}
async function hw466SetExtension(slug, uid, dateStr, note) {
  const ms = hw466ParseDate(dateStr);
  if (dateStr && !ms) { alert('Use a YYYY-MM-DD date.'); return; }
  try {
    const ref = hw466Db().collection('hw466Status').doc(`${slug}_${uid}`);
    const existing = await ref.get();
    const body = {
      dueOverrideAt: ms || null,
      extensionNote: String(note || '').slice(0, 500),
      updatedAt: hw466Now()
    };
    if (!existing.exists) { body.assignment = slug; body.uid = uid; body.createdAt = hw466Now(); }
    await ref.set(body, { merge: true });
    await loadHw466Staff();
  } catch (e) { alert('Could not set the extension: ' + (e.message || e)); }
}
async function hw466AssignSection(uid, code) {
  const val = HW466_SECTION_CODES.includes(code) ? code : null;
  try {
    await hw466Col().collection('profiles').doc(uid).set({
      sectionAssigned: val,
      sectionAssignedBy: hw466MyEmail(),
      sectionAssignedAt: Date.now(),
      updatedAt: hw466Now()
    }, { merge: true });
    await loadHw466Staff();
  } catch (e) { alert('Could not assign the section: ' + (e.message || e)); }
}
async function hw466NewThread(subject, topic, slug, body) {
  if (!subject.trim() || !body.trim()) { alert('A subject and a message, please.'); return; }
  try {
    const ref = await hw466Col().collection('threads').add({
      authorUid: hw466MyUid(), authorEmail: hw466MyEmail(),
      authorName: (_hw466Mine?.profile?.displayName) || (McgheeLab.Auth?.currentUser?.displayName || ''),
      authorRole: hw466IsStaff() ? 'staff' : 'student',
      subject: subject.trim().slice(0, 160),
      topic, assignmentSlug: slug || null,
      status: 'open', createdAt: hw466Now()
    });
    await hw466PostMessage(ref.id, body, { quiet: true });
    _hw466Compose = false;
    await loadHw466Mine();
    await loadHw466Thread(ref.id);
  } catch (e) { alert('Could not send that: ' + (e.message || e)); }
}
async function hw466PostMessage(threadId, body, opts) {
  const text = String(body || '').trim();
  if (!text) return;
  try {
    await hw466Col().collection('threads').doc(threadId).collection('messages').add({
      authorUid: hw466MyUid(), authorEmail: hw466MyEmail(),
      authorName: (McgheeLab.Auth?.currentUser?.displayName || ''),
      // Rules PROVE this against the caller's own staff status, so a wrong
      // value here is a denied write, not a forged one.
      authorRole: hw466IsStaff() ? 'staff' : 'student',
      body: text.slice(0, 4000), createdAt: hw466Now()
    });
    if (!opts?.quiet) await loadHw466Thread(threadId);
  } catch (e) { alert('Could not post: ' + (e.message || e)); }
}
async function hw466SetThreadStatus(threadId, status) {
  try {
    await hw466Col().collection('threads').doc(threadId)
      .update({ status, updatedAt: hw466Now() });
    if (hw466IsStaff()) await loadHw466Staff(); else await loadHw466Mine();
  } catch (e) { alert('Could not change the status: ' + (e.message || e)); }
}
/* The sections export: the seam that lets scripts/hw1_grade.py score the
   566-only fields for 566 students only, while roster data stays out of the
   course repo (write it to Synology, never commit it). */
function hw466SectionsCSV() {
  const rows = (_hw466Staff?.profiles) || [];
  if (!rows.length) { alert('No student profiles yet — students appear here once they open My Homework.'); return; }
  const cell = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const out = ['netid,email,name,section,level,dept,source'];
  rows.forEach(p => {
    const s = bme466Section(p);
    const email = String(p.email || '');
    out.push([email.split('@')[0], email, p.displayName || '',
      s.code || '', s.level || '', s.dept || '', s.source].map(cell).join(','));
  });
  const blob = new Blob([out.join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `bme466_sections_${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/* ── Shared bits of markup ─────────────────────────────────────── */
const HW466_KINDS = [['module', 'Module'], ['report', 'Report'], ['exam', 'Exam'],
                     ['project', 'Project'], ['qe', 'Qualifying exam'], ['other', 'Other']];
const HW466_TOPICS = [['assignment', 'An assignment'], ['grading', 'Grading'],
                      ['logistics', 'Logistics / scheduling'], ['content', 'Course content'],
                      ['other', 'Something else']];
function hw466AudBadge(aud) {
  if (aud === '466') return '<span class="cb-tab-admin-tag" title="Undergraduate section only">466 ONLY</span>';
  if (aud === '566') return '<span class="cb-tab-admin-tag" title="Graduate section only">566 ONLY</span>';
  return '';
}
function hw466KindLabel(k) { return (HW466_KINDS.find(x => x[0] === k) || [, k])[1]; }
function hw466DueCell(a, override) {
  const due = override || a.dueAt;
  if (!due) return '<span class="muted-text">see D2L</span>';
  const s = hw466DateStr(due);
  const late = Date.now() > due;
  return `${override ? '<strong title="Extension granted for you">' : ''}${esc(s)}${override ? '</strong>' : ''}`
       + (late ? ' <span class="muted-text" style="font-size:.8em">(passed)</span>' : '');
}

/* ══ 1. Public Homeworks page ════════════════════════════════════ */
function renderHw466ListBody() {
  if (!_hw466Assigns) loadHw466Assigns();
  const A = _hw466Assigns || {};
  if (!A.rows) return '<p class="muted-text">Loading assignments…</p>';
  if (A.error) return `<p class="muted-text">Could not load assignments: ${esc(A.error)}</p>`;
  const rows = A.rows.filter(a => hw466IsStaff() ? true : a.published !== false);
  if (!rows.length) {
    return `<p class="muted-text">No assignments have been released yet. They appear here as the
      semester goes on — and <strong>D2L is always the authority on deadlines and turn-in</strong>.</p>`;
  }
  const tr = rows.map(a => `
    <tr${a.published === false ? ' style="opacity:.55"' : ''}>
      <td><strong>${esc(a.title || a.slug)}</strong> ${hw466AudBadge(a.audience)}
        ${a.published === false ? '<span class="cb295-dash-no" style="font-size:.8em">draft</span>' : ''}
        ${a.notes ? `<br><span class="muted-text" style="font-size:.82em">${esc(a.notes)}</span>` : ''}</td>
      <td>${esc(hw466KindLabel(a.kind))}</td>
      <td>${hw466DueCell(a)}</td>
      <td>${a.moduleUrl ? `<a class="btn btn-small btn-secondary" href="${escAttr(hw466ModuleHref(a.moduleUrl, _scheduleId))}" target="_blank" rel="noopener">Open module</a>` : ''}
          ${a.d2lLink ? `<a class="btn btn-small btn-secondary" href="${escAttr(a.d2lLink)}" target="_blank" rel="noopener">D2L</a>` : ''}</td>
    </tr>`).join('');
  return `
    <p class="muted-text" style="margin:0 0 10px">
      Everything assigned this semester. <strong>Turn-in and grades live in D2L</strong> —
      this page is the schedule and the links. Items marked
      <span class="cb-tab-admin-tag">466 ONLY</span> or
      <span class="cb-tab-admin-tag">566 ONLY</span> are for that level only;
      sign in and open <em>My Homework</em> to see just yours.</p>
    <div class="cb295-dash-tablewrap"><table class="cb295-dash-table">
      <thead><tr><th>Assignment</th><th>Type</th><th>Due</th><th></th></tr></thead>
      <tbody>${tr}</tbody></table></div>`;
}
function wireHw466List() {
  /* Nothing interactive: plain links, and refreshing is a page action. The
     loader kicks off from the renderer and repaints when it lands. */
}

/* ══ 2. Student dashboard ════════════════════════════════════════ */
function renderHw466MineBody() {
  if (!bme466SignedInStudent()) {
    return `
      <section class="cb295-assess-panel cb295-assess-panel-signedout">
        <h3>My Homework</h3>
        <p>Sign in with your <strong>UA NetID</strong> (the Google button — arizona.edu)
           to see your assignments, keep your progress across devices, and message
           the instructor and TA.</p>
        <p class="muted-text">Signed in with a different account? The homework modules
           and this page both require an <code>@arizona.edu</code> address.</p>
      </section>`;
  }
  if (!_hw466Assigns) loadHw466Assigns();
  if (!_hw466Mine && _hw466Assigns?.rows) loadHw466Mine();
  const A = _hw466Assigns || {}, M = _hw466Mine || {};
  if (!A.rows || M.loading || !M.statuses) return '<p class="muted-text">Loading your assignments…</p>';

  const sec = bme466Section(M.profile);
  const published = A.rows.filter(a => a.published !== false);
  const mine = published.filter(a => hw466InAudience(a, sec));

  const card = (a) => {
    const st = M.statuses.get(a.slug) || {};
    const pr = M.progress.get(a.slug);
    const pct = (pr && pr.totalQuestions)
      ? Math.round(100 * (pr.answeredCount || 0) / pr.totalQuestions) : null;
    const done = !!st.selfMarked;
    return `
      <tr>
        <td><strong>${esc(a.title || a.slug)}</strong> ${hw466AudBadge(a.audience)}
          ${st.dueOverrideAt ? '<span class="cb295-dash-yes" style="font-size:.8em">extension</span>' : ''}
          ${a.moduleUrl ? `<br><a href="${escAttr(hw466ModuleHref(a.moduleUrl, _scheduleId))}" target="_blank" rel="noopener" style="font-size:.85em">open the module →</a>` : ''}
          ${st.feedback ? `<br><span class="muted-text" style="font-size:.82em">Note from staff: ${esc(st.feedback)}</span>` : ''}</td>
        <td>${hw466DueCell(a, st.dueOverrideAt)}</td>
        <td>${pct === null ? '<span class="muted-text">—</span>' :
          `<div class="teach-eng-bar"><div class="teach-eng-fill" style="width:${pct}%"></div></div>
           <span class="muted-text" style="font-size:.78em">${pr.answeredCount || 0}/${pr.totalQuestions} answered</span>`}</td>
        <td>${st.ackBy ? '<span class="cb295-dash-yes">✓ received</span>' : '<span class="muted-text">—</span>'}</td>
        <td><button type="button" class="btn btn-small ${done ? 'btn-secondary' : 'btn-primary'} hw466-mine-mark"
              data-slug="${escAttr(a.slug)}" data-on="${done ? '0' : '1'}"
              title="${done ? 'Undo — you have not uploaded it after all' : 'Tell us you uploaded it to D2L. This is not the turn-in; D2L is.'}">
              ${done ? 'Uploaded ✓' : 'I uploaded it'}</button></td>
      </tr>`;
  };
  const pending = mine.filter(a => !(M.statuses.get(a.slug) || {}).selfMarked);
  const complete = mine.filter(a => (M.statuses.get(a.slug) || {}).selfMarked);
  const table = (rows, empty) => rows.length ? `
    <div class="cb295-dash-tablewrap"><table class="cb295-dash-table">
      <thead><tr><th>Assignment</th><th>Due</th><th>Module progress</th><th>Staff</th><th></th></tr></thead>
      <tbody>${rows.map(card).join('')}</tbody></table></div>`
    : `<p class="muted-text">${empty}</p>`;

  /* Section: staff-assigned wins, and when we don't know we show everything
     rather than guessing (a hidden 566-only assignment is the bad outcome). */
  const secNote = sec.source === 'staff'
    ? `<span class="cb295-dash-yes">${esc(sec.code)}</span> <span class="muted-text">(set by the teaching team)</span>`
    : sec.source === 'claim'
      ? `<span class="cb295-dash-yes">${esc(sec.code)}</span> <span class="muted-text">(as you told us — staff can correct it)</span>`
      : `<span class="cb295-dash-no">not set</span> <span class="muted-text">— you are seeing every assignment,
         including ones only for the other level. Pick your section below.</span>`;
  const p = M.profile || {};
  const opt = (v, l, cur) => `<option value="${escAttr(v)}"${v === (cur || '') ? ' selected' : ''}>${esc(l)}</option>`;
  const profileCard = `
    <section class="cb295-dash-card">
      <header class="cb295-dash-card-header"><h3>My profile</h3>
        <span><button type="button" class="btn btn-small btn-primary" id="hw466-profile-save">Save</button></span></header>
      <p class="muted-text" style="margin:4px 0 10px;font-size:.85em">
        Your section decides which assignments are yours (the 566 parts of a homework, the
        qualifying exam, project team rules). Registrar records are the truth; if what you
        pick and what we have differ, the teaching team's value wins.</p>
      <div class="addrow" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:8px">
        <input type="text" id="hw466-p-name" class="cb-input" style="width:200px" placeholder="Preferred name" value="${escAttr(p.displayName || '')}">
        <input type="text" id="hw466-p-pron" class="cb-input" style="width:130px" placeholder="Pronouns" value="${escAttr(p.pronouns || '')}">
        <input type="text" id="hw466-p-major" class="cb-input" style="width:170px" placeholder="Major" value="${escAttr(p.major || '')}">
        <input type="text" id="hw466-p-year" class="cb-input" style="width:130px" placeholder="Year" value="${escAttr(p.year || '')}">
        <select id="hw466-p-section" class="cb-input" style="width:auto">
          ${opt('', 'Which section are you in?', p.sectionClaim)}
          ${HW466_SECTION_CODES.map(c => opt(c, c.replace(/(\d)/, ' $1'), p.sectionClaim)).join('')}
        </select>
      </div>
      <textarea id="hw466-p-int" class="cb-input" rows="2" style="width:100%"
        placeholder="Anything you want us to know — interests, what you want out of the course, accommodations you'd rather mention here than in class.">${esc(p.interests || '')}</textarea>
      <p class="muted-text" style="font-size:.82em;margin-top:6px">Your section: ${secNote}</p>
    </section>`;

  /* Requests: threads are private to the author + staff. */
  const threads = M.threads || [];
  const openThread = _hw466Thread && threads.some(t => t.id === _hw466Thread.id) ? _hw466Thread : null;
  const threadRows = threads.map(t => `
    <tr${t.unreadForAuthor ? ' style="font-weight:600"' : ''}>
      <td><a href="#" class="hw466-thread-open" data-id="${escAttr(t.id)}">${esc(t.subject || '(no subject)')}</a>
        ${t.unreadForAuthor ? ' <span class="cb-tab-admin-tag" title="New reply">NEW</span>' : ''}
        <br><span class="muted-text" style="font-size:.8em">${esc(t.lastMessagePreview || '')}</span></td>
      <td>${esc(t.status || 'open')}</td>
      <td>${t.lastMessageAt ? esc(fmtRelativeTime(new Date(hw466Ms(t.lastMessageAt)))) : '—'}</td>
    </tr>`).join('');
  const requestsCard = `
    <section class="cb295-dash-card">
      <header class="cb295-dash-card-header"><h3>My requests to the instructor &amp; TA</h3>
        <span><button type="button" class="btn btn-small btn-primary" id="hw466-req-new">${_hw466Compose ? 'Cancel' : 'New request'}</button></span></header>
      <p class="muted-text" style="margin:4px 0 10px;font-size:.85em">
        Private: only you and the teaching team can read a thread. Good for extensions,
        an assignment question, or anything you would rather not ask in front of the class.
        Messages cannot be edited or deleted once sent, by you or by us.</p>
      ${_hw466Compose ? `
        <div class="addrow" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px">
          <input type="text" id="hw466-req-subject" class="cb-input" style="width:260px" placeholder="Subject">
          <select id="hw466-req-topic" class="cb-input" style="width:auto">
            ${HW466_TOPICS.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('')}
          </select>
          <select id="hw466-req-slug" class="cb-input" style="width:auto">
            <option value="">(not about a specific assignment)</option>
            ${mine.map(a => `<option value="${escAttr(a.slug)}">${esc(a.title || a.slug)}</option>`).join('')}
          </select>
        </div>
        <textarea id="hw466-req-body" class="cb-input" rows="3" style="width:100%" placeholder="What do you need?"></textarea>
        <p style="margin-top:6px"><button type="button" class="btn btn-small btn-primary" id="hw466-req-send">Send</button></p>` : ''}
      ${threads.length ? `<div class="cb295-dash-tablewrap"><table class="cb295-dash-table">
        <thead><tr><th>Subject</th><th>Status</th><th>Last activity</th></tr></thead>
        <tbody>${threadRows}</tbody></table></div>` : '<p class="muted-text">No requests yet.</p>'}
      ${openThread ? hw466ThreadPanel(openThread, threads.find(t => t.id === openThread.id)) : ''}
    </section>`;

  return `
    <section class="cb295-dash-card">
      <header class="cb295-dash-card-header"><h3>Pending — ${pending.length}</h3>
        <span><button type="button" class="btn btn-small btn-secondary" id="hw466-mine-refresh">Refresh</button></span></header>
      <p class="muted-text" style="margin:4px 0 10px;font-size:.85em">
        <strong>D2L is still the turn-in and the gradebook.</strong> "I uploaded it" tells the
        teaching team you're done so we can chase the right people — it is not a submission
        and it is not a grade.</p>
      ${table(pending, 'Nothing pending. Either you are done or nothing is released yet.')}
    </section>
    <section class="cb295-dash-card">
      <header class="cb295-dash-card-header"><h3>Completed — ${complete.length}</h3></header>
      ${table(complete, 'Nothing marked done yet.')}
    </section>
    ${profileCard}
    ${requestsCard}`;
}
/** The conversation view, shared by the student tab and the staff inbox. */
function hw466ThreadPanel(open, meta) {
  if (!open.msgs) return '<p class="muted-text">Loading the conversation…</p>';
  if (open.error) return `<p class="muted-text">Could not load it: ${esc(open.error)}</p>`;
  const bubbles = open.msgs.map(m => {
    const staff = m.authorRole === 'staff';
    return `<div style="margin:8px 0;padding:8px 10px;border-radius:8px;border:1px solid var(--border,#e5e7eb);
       ${staff ? 'background:rgba(59,130,246,.07)' : ''}">
      <div class="muted-text" style="font-size:.78em">
        ${esc(m.authorName || m.authorEmail || '')} ${staff ? '<span class="cb-tab-admin-tag">STAFF</span>' : ''}
        · ${m.createdAt ? esc(fmtRelativeTime(new Date(hw466Ms(m.createdAt)))) : 'just now'}</div>
      <div style="white-space:pre-wrap">${esc(m.body || '')}</div>
    </div>`;
  }).join('');
  const closed = (meta?.status || 'open') === 'closed';
  return `
    <div style="margin-top:12px;border-top:1px solid var(--border,#e5e7eb);padding-top:10px">
      <h4 style="margin:0 0 4px">${esc(meta?.subject || 'Conversation')}</h4>
      ${bubbles || '<p class="muted-text">No messages.</p>'}
      <textarea id="hw466-msg-body" class="cb-input" rows="2" style="width:100%" placeholder="${closed ? 'This thread is closed — reopening it posts a new message.' : 'Reply…'}"></textarea>
      <p style="margin-top:6px">
        <button type="button" class="btn btn-small btn-primary" id="hw466-msg-send" data-id="${escAttr(open.id)}">Send</button>
        ${hw466IsStaff() ? `
          <button type="button" class="btn btn-small btn-secondary hw466-thread-status" data-id="${escAttr(open.id)}" data-status="answered">Mark answered</button>
          <button type="button" class="btn btn-small btn-secondary hw466-thread-status" data-id="${escAttr(open.id)}" data-status="closed">Close</button>`
        : `<button type="button" class="btn btn-small btn-secondary hw466-thread-status" data-id="${escAttr(open.id)}" data-status="${closed ? 'open' : 'closed'}">${closed ? 'Reopen' : 'Close'}</button>`}
      </p>
    </div>`;
}

/* ══ 3. Staff surface: assign, matrix, inbox, sections ═══════════ */
function renderHw466AssignBody() {
  if (!hw466IsStaff()) {
    return '<p class="muted-text">This surface is for the instructor and TAs.</p>';
  }
  if (!_hw466Assigns) loadHw466Assigns();
  if (!_hw466Staff) loadHw466Staff();
  const A = _hw466Assigns || {}, S = _hw466Staff || {};
  // Say "loading" rather than flashing "No requests yet" at someone whose data
  // is a round-trip away — an empty state that turns out to be wrong reads as
  // a broken page.
  if (S.loading || !A.rows) return '<p class="muted-text">Loading assignments, status and requests…</p>';
  const staffOnlyNote = (_isCourseStaff && _viewType !== 'admin')
    ? `<p class="muted-text" style="font-size:.85em">You are signed in as <strong>course staff (TA)</strong>:
       you can assign homework, see status, set extensions and answer requests. The class
       roster, page editing and progress deletion stay with the instructor.</p>` : '';

  /* ── assignment manager ── */
  let manager;
  if (A.error) manager = `<p class="muted-text">Could not load assignments: ${esc(A.error)}</p>`;
  else {
    const rows = A.rows.map(a => `
      <tr${a.published === false ? ' style="opacity:.7"' : ''}>
        <td><strong>${esc(a.title || a.slug)}</strong> ${hw466AudBadge(a.audience)}
          <br><span class="muted-text" style="font-size:.78em"><code>${esc(a.slug)}</code>${a.progressKey ? ` · module key <code>${esc(a.progressKey)}</code>` : ''}</span></td>
        <td>${esc(hw466KindLabel(a.kind))}</td>
        <td>${a.dueAt ? esc(hw466DateStr(a.dueAt)) : '<span class="muted-text">—</span>'}</td>
        <td>${a.published ? '<span class="cb295-dash-yes">✓ released</span>' : '<span class="cb295-dash-no">draft</span>'}</td>
        <td>
          <button type="button" class="btn btn-small btn-secondary hw466-a-edit" data-slug="${escAttr(a.slug)}">Edit</button>
          <button type="button" class="btn btn-small ${a.published ? 'btn-secondary' : 'btn-primary'} hw466-a-pub"
            data-slug="${escAttr(a.slug)}" data-on="${a.published ? '0' : '1'}">${a.published ? 'Unpublish' : 'Publish'}</button>
          <button type="button" class="btn btn-small hw466-a-matrix btn-secondary" data-slug="${escAttr(a.slug)}">Status</button>
          ${_viewType === 'admin' ? `<button type="button" class="btn btn-small btn-secondary hw466-a-del" data-slug="${escAttr(a.slug)}" title="Delete the record">${ICON.svg('trash')}</button>` : ''}
        </td>
      </tr>`).join('');
    manager = `<div class="cb295-dash-tablewrap"><table class="cb295-dash-table">
      <thead><tr><th>Assignment</th><th>Type</th><th>Due</th><th>Release</th><th></th></tr></thead>
      <tbody>${rows || '<tr><td colspan="5" class="muted-text">No assignment records yet.</td></tr>'}</tbody></table></div>`;
  }
  /* ── the editor form ── */
  let editor = '';
  if (_hw466Editing) {
    const a = _hw466Editing === '__new__' ? { audience: 'all', kind: 'module', order: (A.rows?.length || 0) }
      : (A.rows || []).find(x => x.slug === _hw466Editing) || {};
    const isNew = _hw466Editing === '__new__';
    editor = `
      <div style="border:1px solid var(--border,#e5e7eb);border-radius:8px;padding:10px;margin:10px 0">
        <h4 style="margin:0 0 8px">${isNew ? 'New assignment' : 'Editing ' + esc(a.slug)}</h4>
        <div class="addrow" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px">
          <input type="text" id="hw466-f-slug" class="cb-input" style="width:150px" placeholder="id (hw3-blood)"
            value="${escAttr(a.slug || '')}"${isNew ? '' : ' readonly title="The id is the document id and cannot change — make a new record instead."'}>
          <input type="text" id="hw466-f-title" class="cb-input" style="width:260px" placeholder="Title" value="${escAttr(a.title || '')}">
          <select id="hw466-f-kind" class="cb-input" style="width:auto">
            ${HW466_KINDS.map(([v, l]) => `<option value="${v}"${v === a.kind ? ' selected' : ''}>${esc(l)}</option>`).join('')}
          </select>
          <select id="hw466-f-aud" class="cb-input" style="width:auto" title="Which level this is for. The BME/AME axis is recorded but never used to target work.">
            <option value="all"${a.audience === 'all' ? ' selected' : ''}>Everyone</option>
            <option value="466"${a.audience === '466' ? ' selected' : ''}>466 only (undergrad)</option>
            <option value="566"${a.audience === '566' ? ' selected' : ''}>566 only (grad)</option>
          </select>
          <input type="number" id="hw466-f-order" class="cb-input" style="width:80px" placeholder="order" value="${escAttr(String(a.order ?? 0))}">
        </div>
        <div class="addrow" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px">
          <label style="font-size:.85em">Due <input type="date" id="hw466-f-due" class="cb-input" value="${escAttr(hw466DateStr(a.dueAt))}"></label>
          <label style="font-size:.85em">Opens <input type="date" id="hw466-f-opens" class="cb-input" value="${escAttr(hw466DateStr(a.opensAt))}"></label>
          <input type="text" id="hw466-f-module" class="cb-input" style="width:280px" placeholder="modules/bme466/….html" value="${escAttr(a.moduleUrl || '')}">
          <input type="text" id="hw466-f-d2l" class="cb-input" style="width:220px" placeholder="D2L link (optional)" value="${escAttr(a.d2lLink || '')}">
          <input type="text" id="hw466-f-pkey" class="cb-input" style="width:170px" placeholder="module key (bme466-hw3)" value="${escAttr(a.progressKey || '')}"
            title="Links this record to the module's cloud-save key so students see their progress here. Also keeps schedules/bme466.hwProgressKeys in step, so a new module needs no rules deploy.">
        </div>
        <textarea id="hw466-f-notes" class="cb-input" rows="2" style="width:100%" placeholder="Notes shown to students (e.g. '566 students also answer parts d–e')">${esc(a.notes || '')}</textarea>
        <p class="muted-text" style="font-size:.8em;margin:6px 0">Never put a grade, score or per-student note here — a published
          assignment doc is world-readable, and the rules reject those fields.</p>
        <p><label style="font-size:.85em;margin-right:10px"><input type="checkbox" id="hw466-f-pub"${a.published ? ' checked' : ''}> Released to students</label>
          <button type="button" class="btn btn-small btn-primary" id="hw466-f-save">Save</button>
          <button type="button" class="btn btn-small btn-secondary" id="hw466-f-cancel">Cancel</button></p>
      </div>`;
  }

  /* ── status matrix ── */
  let matrix = '';
  if (_hw466Matrix) {
    const a = (A.rows || []).find(x => x.slug === _hw466Matrix);
    const profiles = (S.profiles || []).slice()
      .sort((x, y) => String(x.displayName || x.email || '').localeCompare(String(y.displayName || y.email || '')));
    const relevant = profiles.filter(p => hw466InAudience(a, bme466Section(p)));
    const rows = relevant.map(p => {
      const st = (S.statuses && S.statuses.get(p.uid)) || {};
      const pr = (S.progress && S.progress.get(p.uid)) || null;
      const sec = bme466Section(p);
      const pct = (pr && pr.totalQuestions) ? Math.round(100 * (pr.answeredCount || 0) / pr.totalQuestions) : null;
      return `<tr>
        <td>${esc(p.displayName || '')}<br><span class="muted-text" style="font-size:.78em">${esc(p.email || '')}</span></td>
        <td>${sec.code ? esc(sec.code)
          /* Not .cb295-dash-no (35% white — the "quietly off" style): a
             missing section is a call to action, not a quiet negative. */
          : '<span class="cb-tab-admin-tag" title="No section on file — this student is left out of per-level counts and is shown every assignment until you set it">no section</span>'}
          <br><select class="cb-input hw466-sec-set" data-uid="${escAttr(p.uid)}" style="width:auto;font-size:.8em">
            <option value="">— assign —</option>
            ${HW466_SECTION_CODES.map(c => `<option value="${c}"${p.sectionAssigned === c ? ' selected' : ''}>${c}</option>`).join('')}
          </select></td>
        <td>${pct === null ? '<span class="muted-text">—</span>' :
          `<div class="teach-eng-bar"><div class="teach-eng-fill" style="width:${pct}%"></div></div>
           <span class="muted-text" style="font-size:.78em">${pr.answeredCount || 0}/${pr.totalQuestions}</span>`}</td>
        <td>${st.selfMarked ? '<span class="cb295-dash-yes">✓ says uploaded</span>' : '<span class="muted-text">not yet</span>'}
          ${st.note ? `<br><span class="muted-text" style="font-size:.78em">${esc(st.note)}</span>` : ''}</td>
        <td>${st.dueOverrideAt ? esc(hw466DateStr(st.dueOverrideAt)) : '<span class="muted-text">—</span>'}
          <br><input type="date" class="cb-input hw466-ext-set" data-uid="${escAttr(p.uid)}" style="font-size:.8em"
            value="${escAttr(hw466DateStr(st.dueOverrideAt))}" title="Per-student extension"></td>
        <td><button type="button" class="btn btn-small ${st.ackBy ? 'btn-secondary' : 'btn-primary'} hw466-ack"
              data-uid="${escAttr(p.uid)}" data-on="${st.ackBy ? '0' : '1'}">${st.ackBy ? 'Received ✓' : 'Mark received'}</button></td>
      </tr>`;
    }).join('');
    const said = relevant.filter(p => ((S.statuses && S.statuses.get(p.uid)) || {}).selfMarked).length;
    matrix = `
      <section class="cb295-dash-card">
        <header class="cb295-dash-card-header">
          <h3>Status — ${esc(a?.title || _hw466Matrix)}</h3>
          <span><button type="button" class="btn btn-small btn-secondary" id="hw466-matrix-refresh">Refresh</button>
            <button type="button" class="btn btn-small btn-secondary" id="hw466-matrix-close">Close</button></span>
        </header>
        <p class="muted-text" style="margin:4px 0 10px;font-size:.85em">
          ${said} of ${relevant.length} students in this audience say they uploaded it.
          Rows come from student <em>profiles</em> — a student appears once they have opened
          <em>My Homework</em>, so this is not the full class list until everyone has.
          ${a?.audience !== 'all' ? `Students with no section on file are shown anyway rather than hidden — set theirs in the Section column.` : ''}
          No grades here: acknowledgement means "we have it", nothing more.</p>
        ${rows ? `<div class="cb295-dash-tablewrap"><table class="cb295-dash-table">
          <thead><tr><th>Student</th><th>Section</th><th>Module progress</th><th>Self-report</th><th>Extension</th><th></th></tr></thead>
          <tbody>${rows}</tbody></table></div>` : '<p class="muted-text">No student profiles yet.</p>'}
      </section>`;
  }

  /* ── requests inbox ── */
  const threads = S.threads || [];
  const unread = threads.filter(t => t.unreadForStaff).length;
  const openThread = _hw466Thread && threads.some(t => t.id === _hw466Thread.id) ? _hw466Thread : null;
  const inboxRows = threads.map(t => `
    <tr${t.unreadForStaff ? ' style="font-weight:600"' : ''}>
      <td><a href="#" class="hw466-thread-open" data-id="${escAttr(t.id)}">${esc(t.subject || '(no subject)')}</a>
        ${t.unreadForStaff ? ' <span class="cb-tab-admin-tag">NEW</span>' : ''}
        <br><span class="muted-text" style="font-size:.8em">${esc(t.lastMessagePreview || '')}</span></td>
      <td>${esc(t.authorName || '')}<br><span class="muted-text" style="font-size:.78em">${esc(t.authorEmail || '')}</span></td>
      <td>${esc(t.topic || '')}${t.assignmentSlug ? `<br><span class="muted-text" style="font-size:.78em">${esc(t.assignmentSlug)}</span>` : ''}</td>
      <td>${esc(t.status || 'open')}</td>
      <td>${t.lastMessageAt ? esc(fmtRelativeTime(new Date(hw466Ms(t.lastMessageAt)))) : '—'}</td>
    </tr>`).join('');

  const sectionCounts = HW466_SECTION_CODES.map(c => {
    const n = (S.profiles || []).filter(p => bme466Section(p).code === c).length;
    return `${c}: ${n}`;
  }).join(' · ');
  const unknownSec = (S.profiles || []).filter(p => bme466Section(p).source === 'unknown').length;

  return `
    ${staffOnlyNote}
    ${(S.errors && S.errors.length) ? `<p class="muted-text">Some data could not be loaded: ${esc(S.errors.join('; '))}</p>` : ''}
    <section class="cb295-dash-card">
      <header class="cb295-dash-card-header">
        <h3>Assignments — assign homework</h3>
        <span><button type="button" class="btn btn-small btn-primary" id="hw466-a-new">New assignment</button>
          <button type="button" class="btn btn-small btn-secondary" id="hw466-a-refresh">Refresh</button></span>
      </header>
      <p class="muted-text" style="margin:4px 0 10px;font-size:.85em">
        A <strong>draft</strong> is invisible to students; <strong>publish</strong> puts it on the
        public Homeworks page and notifies the students it is for. Audience targets the
        <em>level</em> (466 vs 566) — the BME/AME half of a section is recorded for reporting
        and never changes who gets what. Dates here are a courtesy display:
        <strong>D2L remains the authority</strong>.</p>
      ${editor}
      ${manager}
    </section>
    ${matrix}
    <section class="cb295-dash-card">
      <header class="cb295-dash-card-header">
        <h3>Student requests${unread ? ` — ${unread} new` : ''}</h3>
        <span><button type="button" class="btn btn-small btn-secondary" id="hw466-inbox-refresh">Refresh</button></span>
      </header>
      <p class="muted-text" style="margin:4px 0 10px;font-size:.85em">
        Private threads between one student and the teaching team. Replies are signed
        <strong>STAFF</strong> automatically — the rules prove the role rather than trusting
        the label — and no message can be edited or deleted after it is sent.</p>
      ${threads.length ? `<div class="cb295-dash-tablewrap"><table class="cb295-dash-table">
        <thead><tr><th>Subject</th><th>Student</th><th>About</th><th>Status</th><th>Last activity</th></tr></thead>
        <tbody>${inboxRows}</tbody></table></div>` : '<p class="muted-text">No requests yet.</p>'}
      ${openThread ? hw466ThreadPanel(openThread, threads.find(t => t.id === openThread.id)) : ''}
    </section>
    <section class="cb295-dash-card">
      <header class="cb295-dash-card-header"><h3>Sections</h3>
        <span><button type="button" class="btn btn-small btn-secondary" id="hw466-sec-csv">Export sections CSV</button></span></header>
      <p class="muted-text" style="margin:4px 0 10px;font-size:.85em">
        ${esc(sectionCounts)}${unknownSec ? ` · <strong>${unknownSec} with no section on file</strong>` : ''}.
        The D2L classlist export has no section column (all four catalog lines are merged into
        one shell), so students self-declare and you correct them — assign from the Status
        table above. The CSV feeds <code>scripts/hw1_grade.py --sections</code> so the 566-only
        answers are scored only for 566 students. It contains student names: keep it on
        Synology, never in a repo.</p>
    </section>`;
}

/* ── Wiring ───────────────────────────────────────────────────── */
function wireHw466Mine() {
  document.getElementById('hw466-mine-refresh')?.addEventListener('click', async () => {
    await loadHw466Assigns(); await loadHw466Mine();
  });
  document.querySelectorAll('.hw466-mine-mark').forEach(btn => {
    btn.addEventListener('click', () => hw466SelfMark(btn.dataset.slug, btn.dataset.on === '1'));
  });
  document.getElementById('hw466-profile-save')?.addEventListener('click', () => {
    hw466SaveProfile({
      displayName: document.getElementById('hw466-p-name')?.value,
      pronouns:    document.getElementById('hw466-p-pron')?.value,
      major:       document.getElementById('hw466-p-major')?.value,
      year:        document.getElementById('hw466-p-year')?.value,
      interests:   document.getElementById('hw466-p-int')?.value,
      sectionClaim: document.getElementById('hw466-p-section')?.value
    });
  });
  document.getElementById('hw466-req-new')?.addEventListener('click', () => {
    _hw466Compose = !_hw466Compose; refreshCanvas();
  });
  document.getElementById('hw466-req-send')?.addEventListener('click', () => {
    hw466NewThread(
      document.getElementById('hw466-req-subject')?.value || '',
      document.getElementById('hw466-req-topic')?.value || 'other',
      document.getElementById('hw466-req-slug')?.value || '',
      document.getElementById('hw466-req-body')?.value || '');
  });
  wireHw466ThreadBits();
}
function wireHw466Assign() {
  document.getElementById('hw466-a-new')?.addEventListener('click', () => {
    _hw466Editing = '__new__'; refreshCanvas();
  });
  document.getElementById('hw466-a-refresh')?.addEventListener('click', () => loadHw466Assigns());
  document.getElementById('hw466-inbox-refresh')?.addEventListener('click', () => loadHw466Staff());
  document.getElementById('hw466-matrix-refresh')?.addEventListener('click', () => loadHw466Staff());
  document.getElementById('hw466-matrix-close')?.addEventListener('click', () => {
    _hw466Matrix = null; refreshCanvas();
  });
  document.getElementById('hw466-sec-csv')?.addEventListener('click', hw466SectionsCSV);
  document.querySelectorAll('.hw466-a-edit').forEach(b => b.addEventListener('click', () => {
    _hw466Editing = b.dataset.slug; refreshCanvas();
  }));
  document.querySelectorAll('.hw466-a-pub').forEach(b => b.addEventListener('click', () =>
    hw466TogglePublish(b.dataset.slug, b.dataset.on === '1')));
  document.querySelectorAll('.hw466-a-del').forEach(b => b.addEventListener('click', () =>
    hw466DeleteAssignment(b.dataset.slug)));
  document.querySelectorAll('.hw466-a-matrix').forEach(b => b.addEventListener('click', async () => {
    _hw466Matrix = b.dataset.slug; await loadHw466Staff();
  }));
  document.getElementById('hw466-f-cancel')?.addEventListener('click', () => {
    _hw466Editing = null; refreshCanvas();
  });
  document.getElementById('hw466-f-save')?.addEventListener('click', () => {
    const v = id => document.getElementById('hw466-f-' + id)?.value || '';
    hw466SaveAssignment({
      slug: v('slug'), title: v('title'), kind: v('kind'), audience: v('aud'),
      order: v('order'), dueAt: v('due'), opensAt: v('opens'),
      moduleUrl: v('module'), d2lLink: v('d2l'), progressKey: v('pkey'), notes: v('notes'),
      published: !!document.getElementById('hw466-f-pub')?.checked
    });
  });
  document.querySelectorAll('.hw466-ack').forEach(b => b.addEventListener('click', () =>
    hw466Ack(_hw466Matrix, b.dataset.uid, b.dataset.on === '1')));
  document.querySelectorAll('.hw466-sec-set').forEach(sel => sel.addEventListener('change', () =>
    hw466AssignSection(sel.dataset.uid, sel.value)));
  document.querySelectorAll('.hw466-ext-set').forEach(inp => inp.addEventListener('change', () =>
    hw466SetExtension(_hw466Matrix, inp.dataset.uid, inp.value, '')));
  wireHw466ThreadBits();
}
/** Thread list + conversation controls, identical on both surfaces. */
function wireHw466ThreadBits() {
  document.querySelectorAll('.hw466-thread-open').forEach(a => a.addEventListener('click', (ev) => {
    ev.preventDefault();
    loadHw466Thread(a.dataset.id);
  }));
  document.getElementById('hw466-msg-send')?.addEventListener('click', (ev) => {
    const ta = document.getElementById('hw466-msg-body');
    const body = ta?.value || '';
    if (!body.trim()) return;
    if (ta) ta.value = '';
    hw466PostMessage(ev.currentTarget.dataset.id, body);
  });
  document.querySelectorAll('.hw466-thread-status').forEach(b => b.addEventListener('click', () =>
    hw466SetThreadStatus(b.dataset.id, b.dataset.status)));
}

function wireBme295cAdminDash() {
  // "Edit title & dates" → toggles an inline edit modal driven by openSettings
  document.getElementById('cb295-dash-meta-edit')?.addEventListener('click', () => {
    if (typeof openSettings === 'function') openSettings();
  });
  // V3.251 — "View as" per-student moved to the Roster row buttons
  // (`.cb295-roster-viewas`), wired inside wireBme295cRoster() below.

  // ── Test mode (V3.250) ──
  document.getElementById('cb295-testmode-enter')?.addEventListener('click', enterBmeTestMode);
  document.getElementById('cb295-testmode-exit')?.addEventListener('click', () => exitBmeTestMode({ wipe: false }));
  document.getElementById('cb295-testmode-wipe')?.addEventListener('click', () => exitBmeTestMode({ wipe: true }));

  // V3.251 — live discussion monitor cell clicks
  wireBmeLiveMonitorCells();
  // V3.251 — ensure the onSnapshot listener is attached whenever the
  // admin dashboard tab is active. attachBmeDashboardListener is also
  // called inside loadBmeDashboardData; this catches the case where
  // data was loaded previously and the admin re-enters the tab.
  if (_bmeDashboardData) {
    attachBmeDashboardListener();
    // V3.286 — same: re-attach the assessments listener on tab re-entry.
    attachBmeAssessmentsListener();
  }

  // V3.286 — Course assessment panels: gate buttons + CSV exports.
  document.querySelectorAll('#cb295-assess-gate-panel .cb295-assess-gate-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const next = btn.dataset.nextState;
      if (next) setBmeAssessmentState(next);
    });
  });
  document.getElementById('cb295-assess-csv-numeric')?.addEventListener('click', () => bmeDownloadAssessmentsCSV('numeric'));
  document.getElementById('cb295-assess-csv-text')?.addEventListener('click', () => bmeDownloadAssessmentsCSV('text'));

  // V3.269 — Discussion-gates panel: per-row Open/Lock/Reset + the
  // primary callout button at the top.
  document.querySelectorAll('.cb295-discgate-panel .cb295-discgate-row-btn, .cb295-discgate-panel .cb295-discgate-callout-btn').forEach(btn => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const slug = btn.dataset.speakerSlug;
      const nextState = btn.dataset.nextState;
      if (slug && nextState) setBmeDiscussionState(slug, nextState);
    });
  });

  // V3.279 — Daily attendance panel: mark-all toggles, save attendance,
  // per-day Assign-groups.
  const collectAttendance = (day) => {
    const roster = _classData?.studentRoster || [];
    const present = [];
    const absent = [];
    roster.forEach(s => {
      const cb = document.querySelector(`.cb295-att-check[data-day="${day}"][data-student-id="${s.id}"]`);
      if (!cb) return;
      if (cb.checked) present.push(s.id);
      else absent.push(s.id);
    });
    return { present, absent };
  };
  document.querySelectorAll('.cb295-att-mark-all').forEach(btn => {
    btn.addEventListener('click', () => {
      const day = btn.dataset.day;
      const checked = btn.dataset.state === 'all';
      document.querySelectorAll(`.cb295-att-check[data-day="${day}"]`).forEach(cb => { cb.checked = checked; });
    });
  });
  document.querySelectorAll('.cb295-att-save').forEach(btn => {
    btn.addEventListener('click', () => {
      const day = btn.dataset.day;
      const { present, absent } = collectAttendance(day);
      setBmeDailyAttendance(day, present, absent);
    });
  });
  document.querySelectorAll('.cb295-att-assign').forEach(btn => {
    btn.addEventListener('click', async () => {
      const day = btn.dataset.day;
      // Save attendance from current checkbox state first so the
      // assignment uses the visible intent (not the stale stored
      // attendance from earlier in the day).
      const { present, absent } = collectAttendance(day);
      if (!confirm(`Assign ${day}'s groups using the ${present.length} checked (present) student${present.length === 1 ? '' : 's'}? Absent students will lose their group for that day.`)) return;
      await setBmeDailyAttendance(day, present, absent);
      await assignBmeGroupsForDay(day);
    });
  });
  // V3.281 — inline alertness pickers next to each attendance checkbox.
  // Each click flips that (day, student) rating to the button's value
  // and persists. Clicking the active button again does nothing; use the
  // × button to clear back to unrated.
  document.querySelectorAll('.cb295-att-alert-btn').forEach(btn => {
    btn.addEventListener('click', (ev) => {
      ev.preventDefault();
      if (btn.disabled) return;
      bmeSetAlertness(btn.dataset.day, btn.dataset.studentId, Number(btn.dataset.rating));
    });
  });
  document.querySelectorAll('.cb295-att-alert-clear').forEach(btn => {
    btn.addEventListener('click', (ev) => {
      ev.preventDefault();
      bmeSetAlertness(btn.dataset.day, btn.dataset.studentId, null);
    });
  });

  // V3.280 — Gradebook panel handlers.
  // Row click → per-student detail modal. The "Open" button has its
  // own handler too; use stopPropagation on the button so we don't
  // fire both.
  document.querySelectorAll('.cb295-gradebook-row-clickable').forEach(row => {
    row.addEventListener('click', () => {
      const id = row.dataset.studentId;
      if (id) openBmeStudentGradeModal(id);
    });
  });
  document.querySelectorAll('.cb295-gradebook-open').forEach(btn => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const id = btn.dataset.studentId;
      if (id) openBmeStudentGradeModal(id);
    });
  });
  // Weight inputs — debounced persistAll on input. 400ms gives the
  // admin time to type "55" without firing two writes.
  let _bmeGradeWeightTimer = null;
  document.querySelectorAll('.cb295-gradebook-weight-input').forEach(input => {
    input.addEventListener('input', () => {
      clearTimeout(_bmeGradeWeightTimer);
      _bmeGradeWeightTimer = setTimeout(() => {
        const a = Number(document.querySelector('.cb295-gradebook-weight-input[data-weight="attendance"]')?.value);
        const d = Number(document.querySelector('.cb295-gradebook-weight-input[data-weight="discussion"]')?.value);
        const al = Number(document.querySelector('.cb295-gradebook-weight-input[data-weight="alertness"]')?.value);
        bmeSetGradeWeights(a, d, al);
      }, 400);
    });
  });
  // V3.281 — inline alertness matrix removed in favor of the per-day
  // alertness picker on the Daily attendance panel. The matrix-input
  // handler is gone with it; the per-day picker handlers live up in
  // the V3.281 attendance section.

  // V3.283 — "Grade discussions by group" panel: per-row star picker,
  // clear, and View-the-response handlers. Same writer as the per-
  // student detail modal (`bmeSetDiscussionQuality`), so the two
  // surfaces stay in lock-step.
  document.querySelectorAll('.cb295-grade-disc-panel .cb295-gradebook-star').forEach(btn => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const campus = btn.dataset.campus;
      const group = Number(btn.dataset.group);
      const slug = btn.dataset.speakerSlug;
      const stars = Number(btn.dataset.stars);
      if (!campus || !group || !slug) return;
      bmeSetDiscussionQuality(campus, group, slug, stars);
    });
  });
  document.querySelectorAll('.cb295-grade-disc-panel .cb295-gradebook-star-clear').forEach(btn => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const campus = btn.dataset.campus;
      const group = Number(btn.dataset.group);
      const slug = btn.dataset.speakerSlug;
      if (!campus || !group || !slug) return;
      bmeSetDiscussionQuality(campus, group, slug, null);
    });
  });
  document.querySelectorAll('.cb295-grade-disc-panel .cb295-grade-disc-view').forEach(btn => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const docId = btn.dataset.docId;
      if (docId) openBmeMonitorCellModal(docId);
    });
  });

  // CSV export — assemble blob + click an `<a download>` to trigger
  // the file save without leaving the page.
  document.getElementById('cb295-gradebook-export')?.addEventListener('click', () => {
    try {
      const csv = bmeGradesToCSV();
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const today = new Date();
      const stamp = today.getFullYear() + ('0' + (today.getMonth() + 1)).slice(-2) + ('0' + today.getDate()).slice(-2);
      a.download = `bme295c-grades-${stamp}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (e) {
      alert('Export failed: ' + (e.message || e));
    }
  });

  // V3.272 — Talk videos panel: Save / Remove / inline error hide.
  document.querySelectorAll('.cb295-speaker-video-save').forEach(btn => {
    btn.addEventListener('click', () => {
      const slug = btn.dataset.speakerSlug;
      const input = document.querySelector(`.cb295-speaker-video-input[data-speaker-slug="${slug}"]`);
      const val = input?.value || '';
      setBmeSpeakerVideo(slug, val);
    });
  });
  document.querySelectorAll('.cb295-speaker-video-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      const slug = btn.dataset.speakerSlug;
      if (!confirm('Remove this talk video?')) return;
      setBmeSpeakerVideo(slug, '');
    });
  });
  // Hide the inline error as soon as the admin starts typing again.
  document.querySelectorAll('.cb295-speaker-video-input').forEach(input => {
    input.addEventListener('input', () => {
      const slug = input.dataset.speakerSlug;
      const err = document.querySelector(`.cb295-speaker-video-err[data-speaker-slug="${slug}"]`);
      if (err) err.style.display = 'none';
    });
  });

  // V3.796 — BME 295C waitlist card: wire its buttons, load once per visit.
  wireBmeWaitlistPanel();
  if (document.getElementById('cb295-interest-panel') && _bmeWl.rows === null && !_bmeWl.error) loadBmeWaitlist();

  // V3.261 — instructor editing: collect field values + persist. The
  // bio textarea (V3.266) carries the same `.cb295-instructor-field`
  // class as the inputs, so it's picked up by this same loop.
  document.getElementById('cb295-instructor-save')?.addEventListener('click', async () => {
    const status = document.getElementById('cb295-instructor-save-status');
    if (status) status.textContent = 'Saving…';
    const base = bmeGetInstructors().map(i => ({ ...i }));
    document.querySelectorAll('.cb295-instructor-field').forEach(input => {
      const idx = parseInt(input.dataset.idx, 10);
      const field = input.dataset.field;
      if (Number.isFinite(idx) && field && base[idx]) {
        base[idx][field] = input.value.trim();
      }
    });
    _classData.instructors = base;
    markDirty();
    try {
      await persistAll();
      if (status) status.textContent = 'Saved.';
      // Refresh the chat sidebar in case the user navigates back — and the
      // syllabus tab on next render — without forcing a full canvas redraw.
      refreshBmeChatMembersAside();
      setTimeout(() => { if (status) status.textContent = ''; }, 2000);
    } catch (e) {
      if (status) status.textContent = 'Save failed: ' + (e.message || e);
    }
  });

  // V3.266 — instructor photo upload. File picker on each row writes
  // straight to Firebase Storage at `class-profile-photos/bme295c/
  // {adminUid}/instructor-{idx}.{ext}` (path embeds the signed-in
  // admin's uid so the storage.rules `request.auth.uid == userId`
  // gate is satisfied — every admin uploads under their own uid),
  // then stamps the resulting URL on `_classData.instructors[idx].
  // photoUrl` and persists. Idempotent — re-uploading replaces the
  // file at the same path.
  document.querySelectorAll('.cb295-instructor-photo-input').forEach(input => {
    input.addEventListener('change', async (ev) => {
      const auth = McgheeLab.Auth;
      const idx = parseInt(input.dataset.idx, 10);
      const file = ev.target.files?.[0];
      const statusEl = document.querySelector(`.cb295-instructor-photo-status[data-idx="${idx}"]`);
      input.value = '';
      if (!file || !Number.isFinite(idx)) return;
      if (!auth?.currentUser) {
        if (statusEl) statusEl.textContent = 'Sign in to upload.';
        return;
      }
      if (statusEl) statusEl.textContent = 'Uploading…';
      const ext = (file.name.match(/\.[a-zA-Z0-9]+$/) || ['.jpg'])[0];
      const path = `class-profile-photos/bme295c/${auth.currentUser.uid}/instructor-${idx}${ext}`;
      try {
        const ref = firebase.storage().ref(path);
        await ref.put(file, { contentType: file.type || 'image/jpeg' });
        const url = await ref.getDownloadURL();
        const base = bmeGetInstructors().map(i => ({ ...i }));
        if (!base[idx]) {
          if (statusEl) statusEl.textContent = 'Upload failed — no instructor row.';
          return;
        }
        base[idx].photoUrl = url;
        base[idx].photoStoragePath = path;
        _classData.instructors = base;
        markDirty();
        await persistAll();
        // Surgical preview update — no canvas redraw.
        const frame = document.getElementById(`cb295-instructor-photo-${idx}`);
        if (frame) frame.innerHTML = `<img src="${esc(url)}" alt="${esc(base[idx].name || '')}" />`;
        // Refresh dependents (chat sidebar instructor avatars).
        refreshBmeChatMembersAside();
        if (statusEl) statusEl.textContent = 'Uploaded.';
        setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 2500);
      } catch (e) {
        console.error('[BME295C] instructor photo upload failed', e);
        if (statusEl) statusEl.textContent = 'Upload failed: ' + (e.message || e);
      }
    });
  });

  // Everything below was originally in wireBme295cRoster() and moved
  // into the dashboard tab in V3.249.
  wireBme295cRoster();
}

/** Enter test mode: flip the schedule flag, inject 4 test students if
 * none exist yet, and persist. The banner + write-tagging key off
 * `_classData.testMode === true`.
 */
async function enterBmeTestMode() {
  if (!_classData) return;
  _classData.testMode = true;
  // Convenience: inject test students on first entry so the admin has
  // something to play with right away. Idempotent — skips if any
  // TEST_* student already exists.
  const hasTest = (_classData.studentRoster || []).some(s => typeof s.id === 'string' && s.id.startsWith('TEST_'));
  if (!hasTest) addBmeTestStudents();
  markDirty();
  await persistAll();
  // Force a full re-load so the banner appears and dashboard counts
  // refresh against the new schedule state.
  _bmeDashboardData = null;
  await wireClassPage(_scheduleId);
}

/** Exit test mode. `wipe: true` also deletes all tagged groupResponses,
 * removes TEST_* students, and clears classAdminEmails. `wipe: false`
 * just flips the flag off so the admin can keep the test artifacts
 * around for review.
 */
async function exitBmeTestMode({ wipe }) {
  if (!_classData) return;
  if (wipe) {
    const confirmMsg = [
      'Wipe test data?',
      '',
      'This will:',
      '  • delete every group-response doc tagged testMode:true',
      '  • remove all TEST_* students from the roster',
      '  • clear the class-admin email list',
      '',
      'Manually-added (MAN_*) students and the real student roster are not touched.',
      '',
      'This cannot be undone.'
    ].join('\n');
    if (!confirm(confirmMsg)) return;
  }

  const status = (msg) => {
    const btn = document.getElementById('cb295-testmode-wipe') || document.getElementById('cb295-testmode-exit');
    if (btn) btn.textContent = msg;
  };

  if (wipe) {
    status('Deleting tagged responses…');
    try {
      const snap = await McgheeLab.db.collection('schedules').doc(_scheduleId)
        .collection('groupResponses').where('testMode', '==', true).get();
      // Batch in chunks of 500 (Firestore limit).
      const docs = snap.docs;
      for (let i = 0; i < docs.length; i += 500) {
        const batch = McgheeLab.db.batch();
        docs.slice(i, i + 500).forEach(d => batch.delete(d.ref));
        await batch.commit();
      }
    } catch (e) {
      console.error('[BME295C testmode] response wipe failed', e);
      alert('Failed to delete tagged responses: ' + (e.message || e));
      return;
    }
    // V3.251 — also delete tagged Live Q&A chat messages.
    status('Deleting tagged chat messages…');
    try {
      const snap = await McgheeLab.db.collection('schedules').doc(_scheduleId)
        .collection('classQA').where('testMode', '==', true).get();
      const docs = snap.docs;
      for (let i = 0; i < docs.length; i += 500) {
        const batch = McgheeLab.db.batch();
        docs.slice(i, i + 500).forEach(d => batch.delete(d.ref));
        await batch.commit();
      }
    } catch (e) {
      console.error('[BME295C testmode] chat wipe failed', e);
      alert('Failed to delete tagged chat messages: ' + (e.message || e));
      return;
    }
    // Roster: drop TEST_* students; keep MAN_* + real students.
    _classData.studentRoster = (_classData.studentRoster || []).filter(s =>
      !(typeof s.id === 'string' && s.id.startsWith('TEST_'))
    );
    // Clear class admin invite list.
    _classData.classAdminEmails = [];
  }

  _classData.testMode = false;
  markDirty();
  await persistAll();
  _bmeDashboardData = null;
  _bmeChatMessages = [];
  await wireClassPage(_scheduleId);
}

/* ─── Live Q&A chat (V3.251) ──────────────────────────────────── */

/** Extract first name from a roster name field. Handles "Last, First M"
 * (the UAccess style on most entries) plus "First Last" fallback.
 */
function bmeFirstName(s) {
  const name = (s?.name || '').trim();
  if (!name) return '';
  if (name.includes(',')) {
    const after = name.split(',')[1] || '';
    return (after.trim().split(/\s+/)[0] || '').trim();
  }
  return (name.split(/\s+/)[0] || '').trim();
}

/** Last-initial char for tie-breaking when first names collide. */
function bmeLastInitial(s) {
  const name = (s?.name || '').trim();
  if (!name) return '';
  if (name.includes(',')) return (name.split(',')[0].trim()[0] || '').toUpperCase();
  const parts = name.split(/\s+/);
  return (parts[parts.length - 1]?.[0] || '').toUpperCase();
}

/** Build the mention index: { token: studentId, ... } where token is
 * lowercased `firstname` (or `firstname_l` if there's a name collision).
 * Also returns a reverse map studentId → canonical token so we render
 * the same string on send + on display.
 */
function bmeBuildMentionIndex() {
  const roster = Array.isArray(_classData?.studentRoster) ? _classData.studentRoster : [];
  const byFirst = new Map(); // firstNameLower → [students]
  roster.forEach(s => {
    const f = bmeFirstName(s).toLowerCase();
    if (!f) return;
    if (!byFirst.has(f)) byFirst.set(f, []);
    byFirst.get(f).push(s);
  });
  const tokenToId = new Map();
  const idToToken = new Map();
  for (const [first, students] of byFirst.entries()) {
    if (students.length === 1) {
      tokenToId.set(first, students[0].id);
      idToToken.set(students[0].id, first);
    } else {
      // Disambiguate with last initial. If still ambiguous, fall through
      // to id-based suffix.
      const initialBuckets = new Map();
      students.forEach(s => {
        const init = bmeLastInitial(s).toLowerCase();
        const key = init ? (first + '_' + init) : first;
        if (!initialBuckets.has(key)) initialBuckets.set(key, []);
        initialBuckets.get(key).push(s);
      });
      for (const [key, list] of initialBuckets.entries()) {
        if (list.length === 1) {
          tokenToId.set(key, list[0].id);
          idToToken.set(list[0].id, key);
        } else {
          // Still ambiguous → suffix with last 4 of id.
          list.forEach(s => {
            const t = key + '_' + (s.id || '').slice(-4).toLowerCase();
            tokenToId.set(t, s.id);
            idToToken.set(s.id, t);
          });
        }
      }
    }
  }
  return { tokenToId, idToToken };
}

/** Suggest up to `limit` students whose token starts with `prefix`.
 * Returns [{ id, token, name }] for the dropdown.
 */
function bmeMentionSuggest(prefix, limit = 5) {
  const { idToToken } = bmeBuildMentionIndex();
  const roster = Array.isArray(_classData?.studentRoster) ? _classData.studentRoster : [];
  const p = (prefix || '').toLowerCase();
  const matches = [];
  for (const s of roster) {
    const token = idToToken.get(s.id);
    if (!token) continue;
    if (!p || token.startsWith(p)) {
      matches.push({ id: s.id, token, name: s.name || token });
    }
  }
  // Sort: shorter token first (firstname before firstname_l), then alpha.
  matches.sort((a, b) => (a.token.length - b.token.length) || a.token.localeCompare(b.token));
  return matches.slice(0, limit);
}

/** Resolve all @-mentions in a text string against the current roster.
 * Returns { mentionedIds: string[], cleanedText: string } where
 * cleanedText is unchanged (we render mentions at display time).
 */
function bmeExtractMentions(text) {
  const { tokenToId } = bmeBuildMentionIndex();
  const re = /@([a-z][a-z0-9_]*)/gi;
  const ids = new Set();
  let m;
  while ((m = re.exec(text)) !== null) {
    const token = m[1].toLowerCase();
    const id = tokenToId.get(token);
    if (id) ids.add(id);
  }
  return { mentionedIds: [...ids], cleanedText: text };
}

/** Render `@token` substrings inside an already-escaped HTML string as
 * clickable chips. Input must already be `esc()`-escaped; we operate
 * on the escaped string so this stays XSS-safe.
 */
function bmeRenderMentionsInHtml(escapedText) {
  const { tokenToId } = bmeBuildMentionIndex();
  // Match @[a-z0-9_]+ that follows whitespace, &gt; (line break placeholder), or start-of-string.
  return escapedText.replace(/(^|\s|<br>)@([a-zA-Z][a-zA-Z0-9_]*)/g, (full, prefix, token) => {
    const id = tokenToId.get(token.toLowerCase());
    if (!id) return full;  // unrecognized → leave plain text
    return `${prefix}<span class="cb295-chat-mention" data-student-id="${escAttr(id)}" tabindex="0" role="button">@${esc(token)}</span>`;
  });
}


/** Parse a "8:30 AM" / "11:30 AM" time string and return minutes since
 * midnight, or null if unparseable. Matches the shape in content.json's
 * schedule[].sessions[].time field.
 */
function bmeParseTimeStr(s) {
  if (!s) return null;
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(s.trim());
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const ap = m[3].toUpperCase();
  if (ap === 'PM' && h !== 12) h += 12;
  if (ap === 'AM' && h === 12) h = 0;
  return h * 60 + min;
}

/* ─── Discussion gates (V3.269) ────────────────────────────────
   Per-speaker state machine on the schedule doc:
     pending → open → locked
   - Default for any speaker missing from the map is `pending`.
   - Students can only edit their group-response prompts when `open`.
   - `locked` keeps prior answers visible but greyed out.
   - The admin's open speaker overrides the time-based "currently
     live" derivation, so the Live Q&A chat header + message auto-tag
     follow the admin's gate.
   Gating is client-side only — same trust model as testMode (V3.250)
   and the class-admin list (V3.247). Documented in CHANGELOG V3.269.
   ─────────────────────────────────────────────────────────── */

function bmeGetDiscussionState(slug) {
  const m = _classData?.discussionState;
  if (m && typeof m[slug] === 'string') return m[slug];
  return 'pending';
}
function bmeIsDiscussionOpen(slug)   { return bmeGetDiscussionState(slug) === 'open'; }
function bmeIsDiscussionLocked(slug) { return bmeGetDiscussionState(slug) === 'locked'; }

/** First speaker in schedule order whose state is 'pending'. Used to
 * highlight "Up next" both for students (so they know which discussion
 * is the focus) and for admin (so they see what to open next).
 */
function bmeNextPendingSpeakerSlug() {
  for (const sp of (_bmeContent?.speakers || [])) {
    if (bmeGetDiscussionState(sp.slug) === 'pending') return sp.slug;
  }
  return null;
}

/** First speaker in schedule order whose state is 'open'. Drives the
 * chat header + message auto-tag (see `bmeCurrentLiveSpeaker` below).
 * Returns null when none open.
 */
function bmeAdminOpenSpeakerSlug() {
  for (const sp of (_bmeContent?.speakers || [])) {
    if (bmeGetDiscussionState(sp.slug) === 'open') return sp.slug;
  }
  return null;
}

/** Currently-live speaker slug.
 * V3.269 — admin's discussion gate is the authoritative "now playing"
 * signal. If the admin has opened a speaker's discussion, every chat
 * message + the chat header tag that speaker, regardless of what the
 * schedule grid says. Falls back to the time-based detection (today's
 * day × current time, per `content.json.schedule`) only when admin
 * hasn't opened anything.
 */
function bmeCurrentLiveSpeaker() {
  const opened = bmeAdminOpenSpeakerSlug();
  if (opened) return opened;
  const day = bmeTodayCourseDay();
  if (!day) return null;
  const sched = (_bmeContent?.schedule || []).find(d => d.day === day);
  if (!sched) return null;
  const sessions = (sched.sessions || [])
    .filter(s => s.speakerSlug && s.type === 'talk')
    .map(s => ({ slug: s.speakerSlug, mins: bmeParseTimeStr(s.time) }))
    .filter(s => s.mins != null)
    .sort((a, b) => a.mins - b.mins);
  if (!sessions.length) return null;
  const now = new Date();
  const nowMins = now.getHours() * 60 + now.getMinutes();
  for (let i = 0; i < sessions.length; i++) {
    const start = sessions[i].mins;
    const end = (i + 1 < sessions.length) ? sessions[i + 1].mins : start + 60;
    if (nowMins >= start && nowMins < end) return sessions[i].slug;
  }
  return null;
}

/** V3.269 — write a new state for one speaker's discussion gate.
 * Mutates `_classData.discussionState[slug]`, marks dirty, persists,
 * then triggers a canvas refresh so both the admin dashboard + any
 * open student modules tab pick up the new state.
 */
async function setBmeDiscussionState(slug, nextState) {
  if (!_classData || !slug) return;
  if (!['pending', 'open', 'locked'].includes(nextState)) return;
  const next = { ...(_classData.discussionState || {}), [slug]: nextState };
  _classData.discussionState = next;
  markDirty();
  try {
    await persistAll();
  } catch (e) {
    alert('Could not save discussion state: ' + (e.message || e));
    return;
  }
  refreshCanvas();
}

/** V3.256 — bulk-load every roster student's `users/{uid}.bme295c`
 * profile into `_bmeOtherProfileCache` so the chat members sidebar can
 * show avatars (and click-to-open profile modals don't have to wait on
 * Firestore). The cache was previously only populated by the admin
 * dashboard load + by individual profile-modal opens, which left the
 * sidebar avatar-less for ordinary students.
 *
 * Idempotent via `_bmeChatProfilesLoaded`. Re-rendering the members
 * sidebar in place on completion avoids a full canvas refresh.
 *
 * Also seeds the viewer's own profile (from `_bmeProfile`) into the
 * cache immediately so they see their own photo without needing a
 * round-trip — V3.256 fix for the "I uploaded a photo but the chat
 * doesn't use it" report.
 */
async function loadBmeChatProfiles() {
  // Seed the viewer's own profile right away — this fixes the
  // immediate "where's my photo?" complaint for the just-uploaded case.
  const viewer = _bmeRosterEntry;
  const viewerUid = McgheeLab.Auth?.currentUser?.uid;
  if (viewer && _bmeProfile) {
    // V3.261 — also stash `_uid` on the cached value so admin-edit-other
    // can target the right `users/{uid}` doc without an extra lookup.
    _bmeOtherProfileCache.set(viewer.id, { ..._bmeProfile, _uid: viewerUid });
  }

  if (_bmeChatProfilesLoaded) {
    refreshBmeChatMembersAside();
    return;
  }

  const roster = Array.isArray(_classData?.studentRoster) ? _classData.studentRoster : [];
  // Build the (email → student id) lookup so we can key the cache by id.
  const idByEmail = new Map();
  const emails = [];
  for (const s of roster) {
    const em = (s.email || '').trim().toLowerCase();
    if (!em) continue;
    idByEmail.set(em, s.id);
    emails.push(em);
  }
  if (!emails.length) {
    _bmeChatProfilesLoaded = true;
    refreshBmeChatMembersAside();
    return;
  }

  // Chunk into groups of 10 — Firestore `in` operator's max. Same
  // pattern as `loadBmeDashboardData`.
  for (let i = 0; i < emails.length; i += 10) {
    const chunk = emails.slice(i, i + 10);
    try {
      const snap = await McgheeLab.db.collection('users').where('email', 'in', chunk).get();
      snap.docs.forEach(d => {
        const data = d.data() || {};
        const em = (data.email || '').toLowerCase();
        const sid = em ? idByEmail.get(em) : null;
        if (sid) _bmeOtherProfileCache.set(sid, { ...(data.bme295c || {}), _uid: d.id });
      });
    } catch (e) {
      console.warn('[BME295C chat] profile chunk fetch failed', e);
    }
  }
  _bmeChatProfilesLoaded = true;
  refreshBmeChatMembersAside();
}

/** Surgical re-paint of the chat members sidebar so the avatars + names
 * reflect freshly-loaded profiles. Falls back to a no-op if the chat
 * tab is no longer mounted.
 */
function refreshBmeChatMembersAside() {
  const aside = document.querySelector('.cb295-chat-members');
  if (!aside) return;
  const fresh = renderBmeChatMembersAside();
  const tmp = document.createElement('div');
  tmp.innerHTML = fresh;
  const next = tmp.firstElementChild;
  if (!next) return;
  aside.replaceWith(next);
  // Re-bind the click handlers (the old DOM is gone).
  document.querySelectorAll('.cb295-chat-member-student').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.studentId;
      if (id) openBmeProfileViewModal(id);
    });
  });
  document.querySelectorAll('.cb295-chat-member-instructor').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.instructorIdx, 10);
      if (!isNaN(idx)) openBmeInstructorViewModal(idx);
    });
  });
}

/** Subscribe to the chat collection in real time. Idempotent — calling
 * twice replaces the previous subscription. Tear-down happens in
 * cleanupListeners().
 */
function subscribeBmeChat() {
  if (_bmeChatUnsub) { try { _bmeChatUnsub(); } catch (e) {} _bmeChatUnsub = null; }
  _bmeChatUnsub = McgheeLab.db.collection('schedules').doc(_scheduleId)
    .collection('classQA')
    .orderBy('createdAt', 'asc')
    .limit(500)
    .onSnapshot(snap => {
      _bmeChatMessages = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      renderBmeChatFeedInPlace();
    }, err => {
      console.warn('[BME295C chat] subscription error', err);
    });
}

/** Render one message bubble. Anonymous messages hide author identity
 * from non-admins; admins see a "(by RealName)" tag for moderation.
 */
function renderBmeChatMessage(m) {
  const isQuestion = m.messageType === 'raised_hand';
  const icon = ICON.svg(isQuestion ? 'hand-raised' : 'chat-bubble-left-right');
  const isAnon = m.anonymous === true;
  const isAdmin = _viewType === 'admin';

  const roster = Array.isArray(_classData?.studentRoster) ? _classData.studentRoster : [];
  const authorEmail = (m.authorEmail || '').toLowerCase();
  const authorEntry = authorEmail
    ? roster.find(r => (r.email || '').toLowerCase() === authorEmail)
    : null;

  const displayName = isAnon ? 'Anonymous' : ((m.authorName || '').split(',')[0] || 'someone');
  const canViewProfile = !!authorEntry && (!isAnon || isAdmin);
  const authorEl = canViewProfile
    ? `<button type="button" class="cb295-chat-author-link" data-student-id="${escAttr(authorEntry.id)}">${esc(displayName)}</button>`
    : `<strong>${esc(displayName)}</strong>`;

  const adminTag = (isAnon && isAdmin && m.authorName)
    ? (authorEntry
        ? `<button type="button" class="cb295-chat-msg-anon-tag muted-text cb295-chat-author-link" data-student-id="${escAttr(authorEntry.id)}"> (by ${esc((m.authorName || '').split(',')[0])})</button>`
        : `<span class="cb295-chat-msg-anon-tag muted-text"> (by ${esc((m.authorName || '').split(',')[0])})</span>`)
    : '';

  const speakerSlug = m.speakerSlug;
  const speaker = speakerSlug ? (_bmeContent?.speakers || []).find(s => s.slug === speakerSlug) : null;
  const speakerBadge = speaker
    ? `<span class="cb295-chat-msg-speaker-badge" title="Asked during ${esc(speaker.name)}'s talk">${esc((speaker.name || '').split(',')[0])}</span>`
    : '';
  const timeStr = m.createdAt?.toDate
    ? fmtRelativeTime(m.createdAt)
    : (m.createdAt ? fmtRelativeTime(new Date()) : 'just now');
  const answered = isQuestion && m.answered === true;
  const adminControls = (isQuestion && isAdmin)
    ? `<button type="button" class="btn btn-small cb295-chat-mark-answered"
              data-msg-id="${escAttr(m.id)}"
              data-answered="${answered ? '1' : '0'}">${answered ? 'Mark unanswered' : 'Mark answered'}</button>`
    : '';
  const deleteBtn = isAdmin
    ? `<button type="button" class="btn btn-small btn-secondary cb295-chat-delete"
              data-msg-id="${escAttr(m.id)}" title="Delete message">×</button>`
    : '';

  const viewerId = _bmeRosterEntry?.id;
  const isMentioned = viewerId && Array.isArray(m.mentions) && m.mentions.includes(viewerId);

  const escapedText = esc(m.text || '').replace(/\n/g, '<br>');
  const bodyHtml = bmeRenderMentionsInHtml(escapedText);

  // V3.261 — avatar on each message bubble. Photo lookup order:
  // 1. `m.authorPhotoUrl` (denormalized on the doc at send time — works
  //    for admins / non-roster authors, who aren't in `_bmeOtherProfileCache`).
  // 2. The roster cache by author id (covers older messages without the
  //    denormalized field but where the author is a roster student).
  // 3. Fall through to the message-type icon (🙋 / 💬) as before.
  // Anonymous messages never show the photo — even admins see only the
  // "(by RealName)" tag, not the bitmap.
  let avatarHtml = '';
  if (isAnon) {
    avatarHtml = `<div class="cb295-chat-msg-icon" aria-hidden="true">${icon}</div>`;
  } else {
    const photoUrl = m.authorPhotoUrl
      || (authorEntry ? (_bmeOtherProfileCache.get(authorEntry.id)?.photoUrl || '') : '');
    if (photoUrl) {
      avatarHtml = `<img class="cb295-chat-msg-icon cb295-chat-msg-icon-photo" src="${esc(photoUrl)}" alt="" loading="lazy" />`;
    } else {
      avatarHtml = `<div class="cb295-chat-msg-icon" aria-hidden="true">${icon}</div>`;
    }
  }

  return `
    <div class="cb295-chat-msg cb295-chat-msg-${esc(m.messageType || 'message')}${answered ? ' cb295-chat-msg-answered' : ''}${isAnon ? ' cb295-chat-msg-anon' : ''}${isMentioned ? ' cb295-chat-msg-mention-me' : ''}"
         data-msg-id="${escAttr(m.id)}">
      ${avatarHtml}
      <div class="cb295-chat-msg-body">
        <div class="cb295-chat-msg-meta">
          ${authorEl}${adminTag}
          <span class="muted-text cb295-chat-msg-time" title="${m.createdAt?.toDate ? esc(m.createdAt.toDate().toLocaleString()) : ''}">${esc(timeStr)}</span>
          ${speakerBadge}
          ${answered ? '<span class="cb295-chat-msg-answered-tag">' + ICON.svg('check') + ' answered</span>' : ''}
        </div>
        <div class="cb295-chat-msg-text">${bodyHtml}</div>
        ${(adminControls || deleteBtn) ? `<div class="cb295-chat-msg-controls">${adminControls}${deleteBtn}</div>` : ''}
      </div>
    </div>
  `;
}

/** Rebuild only the feed's inner HTML so the input textarea keeps focus.
 * Auto-scrolls to bottom if the user was already pinned there.
 */
function renderBmeChatFeedInPlace() {
  const feed = document.getElementById('cb295-chat-feed');
  if (!feed) return;
  const wasPinned = _bmeChatScrollPinned;
  if (!_bmeChatMessages.length) {
    feed.innerHTML = '<p class="muted-text cb295-chat-empty">No messages yet — start the conversation.</p>';
  } else {
    feed.innerHTML = _bmeChatMessages.map(renderBmeChatMessage).join('');
  }
  // Re-attach per-message handlers (they're not delegated).
  feed.querySelectorAll('.cb295-chat-mark-answered').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.msgId;
      const wasAnswered = btn.dataset.answered === '1';
      markBmeQuestionAnswered(id, !wasAnswered);
    });
  });
  feed.querySelectorAll('.cb295-chat-delete').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.msgId;
      if (!id) return;
      if (!confirm('Delete this message? This cannot be undone.')) return;
      McgheeLab.db.collection('schedules').doc(_scheduleId)
        .collection('classQA').doc(id).delete()
        .catch(e => alert('Delete failed: ' + (e.message || e)));
    });
  });
  // V3.251 — author-name + mention-chip clicks open the profile-view modal.
  feed.querySelectorAll('.cb295-chat-author-link, .cb295-chat-mention').forEach(el => {
    el.addEventListener('click', (ev) => {
      ev.preventDefault();
      const studentId = el.dataset.studentId;
      if (studentId) openBmeProfileViewModal(studentId);
    });
  });
  if (wasPinned) {
    feed.scrollTop = feed.scrollHeight;
  }
}

function renderBmeChatBody(editing) {
  const auth = McgheeLab.Auth;
  const signedIn = !!auth?.currentUser;
  const liveSlug = bmeCurrentLiveSpeaker();
  const liveSpeaker = liveSlug ? (_bmeContent?.speakers || []).find(s => s.slug === liveSlug) : null;
  const headerSub = liveSpeaker
    ? `<strong class="cb295-chat-live">Currently live:</strong> ${esc(liveSpeaker.name || liveSlug)} — questions auto-tag to this talk.`
    : `<span class="muted-text">No talk in progress — chat is open for conversation.</span>`;

  const inputArea = signedIn
    ? `
      <div class="cb295-chat-input-area">
        <div class="cb295-chat-input-wrap">
          <textarea id="cb295-chat-input" class="cb295-chat-input" rows="2"
                    placeholder="Ask a question, chat with classmates, or type @ to mention someone…"></textarea>
          <div id="cb295-chat-mention-dropdown" class="cb295-chat-mention-dropdown" hidden></div>
        </div>
        <label class="cb295-chat-anon-row">
          <input type="checkbox" id="cb295-chat-anon" />
          <span>Post anonymously</span>
        </label>
        <div class="cb295-chat-actions">
          <button type="button" class="btn cb295-chat-send-question"
                  title="Ask the speaker (raised hand)">${ICON.svg('hand-raised')} Ask</button>
          <button type="button" class="btn btn-secondary cb295-chat-send-message"
                  title="Send to class chat">↗ Send</button>
        </div>
        <p class="muted-text cb295-chat-hint">Tip: <kbd>Cmd/Ctrl + Enter</kbd> sends as a chat message · <kbd>@</kbd> mentions a classmate.</p>
      </div>
    `
    : `
      <div class="cb295-chat-input-area cb295-chat-input-area-signedout">
        <p><strong>Sign in to read the chat and participate.</strong></p>
        <a href="#/classes/bme295c/enroll" class="btn">Sign in</a>
      </div>
    `;

  // Feed initial render. Subscription will replace it on first onSnapshot.
  const feedHtml = signedIn
    ? (_bmeChatMessages.length
        ? _bmeChatMessages.map(renderBmeChatMessage).join('')
        : '<p class="muted-text cb295-chat-empty">Loading chat…</p>')
    : '';

  return `
    <div class="cb295-chat-shell">
      ${renderBmeChatMembersAside()}
      <div class="cb295-chat">
        <header class="cb295-chat-header">
          <h3>Course Chat</h3>
          <p class="cb295-chat-header-sub">${headerSub}</p>
        </header>
        ${signedIn ? `<div id="cb295-chat-feed" class="cb295-chat-feed">${feedHtml}</div>` : ''}
        ${inputArea}
      </div>
    </div>
  `;
}

/** Render the members sidebar (V3.252) — instructors + roster grouped
 * with a tiny avatar + clickable name. Student rows open the profile
 * modal; instructor rows open the instructor info modal. The current
 * viewer's own row is highlighted with `cb295-chat-member-self`.
 */
function renderBmeChatMembersAside() {
  const instructors = bmeGetInstructors();
  const roster = Array.isArray(_classData?.studentRoster) ? _classData.studentRoster.slice() : [];

  // Sort students by first name for the sidebar; campus is shown as a chip.
  roster.sort((a, b) => bmeFirstName(a).toLowerCase().localeCompare(bmeFirstName(b).toLowerCase()));

  const viewerEmail = (McgheeLab.Auth?.currentUser?.email || '').toLowerCase();
  const viewerRosterId = _bmeRosterEntry?.id;

  const instructorRow = (inst, idx) => {
    const first = (inst.name || '').replace(/^(Dr\.|Prof\.|Mr\.|Ms\.|Mrs\.)\s+/i, '').split(/[\s,]+/)[0] || '?';
    const initial = (first || '?').charAt(0).toUpperCase();
    const isSelf = !!inst.email && inst.email.toLowerCase() === viewerEmail;
    // V3.266 — use photoUrl when set; falls back to initial chip.
    const avatar = inst.photoUrl
      ? `<img class="cb295-chat-member-avatar cb295-chat-member-avatar-img" src="${esc(inst.photoUrl)}" alt="" loading="lazy" />`
      : `<span class="cb295-chat-member-avatar">${esc(initial)}</span>`;
    return `
      <li>
        <button type="button"
                class="cb295-chat-member cb295-chat-member-instructor${isSelf ? ' cb295-chat-member-self' : ''}"
                data-instructor-idx="${idx}"
                title="${esc(inst.role || 'Instructor')}">
          ${avatar}
          <span class="cb295-chat-member-body">
            <span class="cb295-chat-member-name">${esc(inst.name || '(instructor)')}</span>
            <span class="cb295-chat-member-meta muted-text">${esc(inst.role || 'Instructor')}</span>
          </span>
        </button>
      </li>
    `;
  };

  const studentRow = (s) => {
    const first = bmeFirstName(s) || (s.name || '?').split(',')[0] || '?';
    const initial = (first || '?').charAt(0).toUpperCase();
    const isSelf = viewerRosterId === s.id;
    const campusChip = s.campus
      ? `<span class="cb295-chat-member-campus">${esc(s.campus.charAt(0))}</span>`
      : '';
    // Try to use a cached photo from the dashboard load if available.
    const email = (s.email || '').toLowerCase();
    const cached = email
      ? (_bmeDashboardData?.profilesByEmail?.get(email)?.bme295c
         || _bmeOtherProfileCache?.get(s.id))
      : null;
    const photoUrl = cached?.photoUrl || '';
    const avatar = photoUrl
      ? `<img class="cb295-chat-member-avatar cb295-chat-member-avatar-img" src="${esc(photoUrl)}" alt="" loading="lazy" />`
      : `<span class="cb295-chat-member-avatar">${esc(initial)}</span>`;
    return `
      <li>
        <button type="button"
                class="cb295-chat-member cb295-chat-member-student${isSelf ? ' cb295-chat-member-self' : ''}"
                data-student-id="${escAttr(s.id)}"
                title="${esc(s.name || first)}${s.campus ? ' · ' + esc(s.campus) : ''}">
          ${avatar}
          <span class="cb295-chat-member-body">
            <span class="cb295-chat-member-name">${esc(first)}${isSelf ? ' <span class="cb295-chat-member-you">(you)</span>' : ''}</span>
            <span class="cb295-chat-member-meta muted-text">${esc((s.name || '').split(',')[0]) === esc(first) ? (s.campus || '') : ((s.name || '').split(',')[0] + (s.campus ? ' · ' + esc(s.campus) : ''))}</span>
          </span>
          ${campusChip}
        </button>
      </li>
    `;
  };

  return `
    <aside class="cb295-chat-members" aria-label="Class members">
      <header class="cb295-chat-members-header">
        <h4>Class</h4>
        <span class="muted-text" style="font-size:.7rem;">${instructors.length} instructor${instructors.length === 1 ? '' : 's'} · ${roster.length} student${roster.length === 1 ? '' : 's'}</span>
      </header>
      <section class="cb295-chat-members-group">
        <h5>Instructors</h5>
        <ul class="cb295-chat-members-list">
          ${instructors.length ? instructors.map(instructorRow).join('') : '<li class="muted-text" style="font-size:.8rem;padding:.25rem .5rem;">No instructors listed.</li>'}
        </ul>
      </section>
      <section class="cb295-chat-members-group">
        <h5>Students</h5>
        <ul class="cb295-chat-members-list">
          ${roster.length ? roster.map(studentRow).join('') : '<li class="muted-text" style="font-size:.8rem;padding:.25rem .5rem;">No students on the roster yet.</li>'}
        </ul>
      </section>
    </aside>
  `;
}

/** Open a read-only modal showing an instructor's info from
 * content.json (name, role, department, office, email).
 */
function openBmeInstructorViewModal(instructorIdx) {
  const inst = bmeGetInstructors()[instructorIdx];
  if (!inst) return;
  closeBmeProfileViewModal();   // close any other profile modal
  closeBmeInstructorViewModal();
  const initial = ((inst.name || '?').replace(/^(Dr\.|Prof\.|Mr\.|Ms\.|Mrs\.)\s+/i, '').charAt(0) || '?').toUpperCase();
  // V3.266 — photo + bio render. photoUrl + bio land on the
  // schedule's instructors[] array via the Instructors panel.
  const photoHtml = inst.photoUrl
    ? `<img class="cb295-mate-photo" src="${esc(inst.photoUrl)}" alt="${esc(inst.name || '')}" />`
    : `<div class="cb295-mate-photo cb295-mate-photo-blank">${esc(initial)}</div>`;
  const bioHtml = inst.bio
    ? `<div class="cb295-profile-view-bio">${esc(inst.bio).replace(/\n/g, '<br>')}</div>`
    : '';
  const modal = document.createElement('div');
  modal.id = 'cb295-instructor-view-modal';
  modal.className = 'cb295-modal-overlay';
  modal.innerHTML = `
    <div class="cb295-modal cb295-profile-view-modal" role="dialog" aria-modal="true" aria-labelledby="cb295-instructor-view-title">
      <button type="button" class="cb295-modal-close" id="cb295-instructor-view-close" aria-label="Close">&times;</button>
      <h3 id="cb295-instructor-view-title">${esc(inst.name || 'Instructor')}</h3>
      <div class="cb295-profile-view-body">
        <div class="cb295-profile-view-photo">
          ${photoHtml}
        </div>
        <dl class="cb295-profile-view-fields">
          ${inst.role ? `<dt>Role</dt><dd>${esc(inst.role)}</dd>` : ''}
          ${inst.department ? `<dt>Department</dt><dd>${esc(inst.department)}</dd>` : ''}
          ${inst.office ? `<dt>Office</dt><dd>${esc(inst.office)}</dd>` : ''}
          ${inst.email ? `<dt>Email</dt><dd><a href="mailto:${esc(inst.email)}">${esc(inst.email)}</a></dd>` : ''}
        </dl>
      </div>
      ${bioHtml}
      <div class="cb295-modal-footer">
        <button type="button" class="btn" id="cb295-instructor-view-done">Close</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  const close = () => closeBmeInstructorViewModal();
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  document.getElementById('cb295-instructor-view-close')?.addEventListener('click', close);
  document.getElementById('cb295-instructor-view-done')?.addEventListener('click', close);
}

function closeBmeInstructorViewModal() {
  document.getElementById('cb295-instructor-view-modal')?.remove();
}

function wireBme295cChat() {
  const auth = McgheeLab.Auth;
  // Members sidebar is rendered even when signed-out; wire clicks first so
  // public viewers can still browse who's in the class.
  document.querySelectorAll('.cb295-chat-member-student').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.studentId;
      if (id) openBmeProfileViewModal(id);
    });
  });
  document.querySelectorAll('.cb295-chat-member-instructor').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.instructorIdx, 10);
      if (!isNaN(idx)) openBmeInstructorViewModal(idx);
    });
  });
  // V3.256 — bulk-load roster profiles so the sidebar shows avatars.
  // Fire-and-forget; the loader calls refreshBmeChatMembersAside() on
  // completion. Skipped if the cache is already warm.
  loadBmeChatProfiles();
  if (!auth?.currentUser) return;
  // Real-time subscription
  subscribeBmeChat();

  // Send buttons
  document.querySelector('.cb295-chat-send-question')?.addEventListener('click', () => sendBmeChatMessage('raised_hand'));
  document.querySelector('.cb295-chat-send-message')?.addEventListener('click', () => sendBmeChatMessage('message'));

  // Textarea behaviors: Cmd/Ctrl+Enter sends; @-mention autocomplete on input
  const ta = document.getElementById('cb295-chat-input');
  if (ta) {
    ta.addEventListener('keydown', (ev) => {
      // Mention dropdown nav keys
      if (_bmeMentionState) {
        const dropdown = document.getElementById('cb295-chat-mention-dropdown');
        if (dropdown && !dropdown.hidden) {
          if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
            ev.preventDefault();
            const items = dropdown.querySelectorAll('.cb295-chat-mention-item');
            if (!items.length) return;
            const delta = ev.key === 'ArrowDown' ? 1 : -1;
            _bmeMentionState.activeIdx = (_bmeMentionState.activeIdx + delta + items.length) % items.length;
            items.forEach((it, i) => it.classList.toggle('cb295-chat-mention-item-active', i === _bmeMentionState.activeIdx));
            return;
          }
          if (ev.key === 'Enter' || ev.key === 'Tab') {
            const items = dropdown.querySelectorAll('.cb295-chat-mention-item');
            const item = items[_bmeMentionState.activeIdx];
            if (item) {
              ev.preventDefault();
              applyBmeMention(item.dataset.studentId);
              return;
            }
          }
          if (ev.key === 'Escape') {
            ev.preventDefault();
            hideBmeMentionDropdown();
            return;
          }
        }
      }
      if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') {
        ev.preventDefault();
        sendBmeChatMessage('message');
      }
    });
    ta.addEventListener('input', updateBmeMentionDropdown);
    ta.addEventListener('blur', () => {
      // Delay hide so a click on a dropdown item still fires.
      setTimeout(() => hideBmeMentionDropdown(), 150);
    });
  }

  // Scroll listener: track whether the user is pinned to the bottom
  const feed = document.getElementById('cb295-chat-feed');
  if (feed) {
    feed.addEventListener('scroll', () => {
      const dist = feed.scrollHeight - (feed.scrollTop + feed.clientHeight);
      _bmeChatScrollPinned = dist < 80;
    });
    // Initial: scroll to bottom and pin
    feed.scrollTop = feed.scrollHeight;
    _bmeChatScrollPinned = true;
  }
}

/** Inspect the textarea around the cursor; if we're typing an @-mention,
 * show + populate the dropdown. Otherwise hide it.
 */
function updateBmeMentionDropdown() {
  const ta = document.getElementById('cb295-chat-input');
  if (!ta) { hideBmeMentionDropdown(); return; }
  const text = ta.value;
  const cursor = ta.selectionStart;
  // Walk back from cursor looking for an '@' that begins a word.
  let atIdx = -1;
  for (let i = cursor - 1; i >= 0; i--) {
    const c = text[i];
    if (c === '@') {
      if (i === 0 || /\s/.test(text[i - 1])) { atIdx = i; }
      break;
    }
    // Stop searching once we hit a separator
    if (/\s/.test(c)) break;
  }
  if (atIdx === -1) { hideBmeMentionDropdown(); return; }
  const prefix = text.slice(atIdx + 1, cursor);
  // Bail if the prefix contains non-word chars (e.g. emoji shortcodes)
  if (/[^a-zA-Z0-9_]/.test(prefix)) { hideBmeMentionDropdown(); return; }
  _bmeMentionState = { startIdx: atIdx, prefix, activeIdx: 0 };

  const suggestions = bmeMentionSuggest(prefix, 6);
  const dropdown = document.getElementById('cb295-chat-mention-dropdown');
  if (!dropdown) return;
  if (!suggestions.length) {
    dropdown.hidden = true;
    dropdown.innerHTML = '';
    return;
  }
  dropdown.innerHTML = suggestions.map((s, i) => `
    <button type="button"
            class="cb295-chat-mention-item${i === 0 ? ' cb295-chat-mention-item-active' : ''}"
            data-student-id="${escAttr(s.id)}"
            data-token="${escAttr(s.token)}">
      <strong>@${esc(s.token)}</strong>
      <span class="muted-text">${esc((s.name || '').split(',')[0])}</span>
    </button>
  `).join('');
  dropdown.hidden = false;
  dropdown.querySelectorAll('.cb295-chat-mention-item').forEach(item => {
    item.addEventListener('mousedown', (ev) => {
      ev.preventDefault();  // don't blur the textarea
      applyBmeMention(item.dataset.studentId);
    });
    item.addEventListener('mouseenter', () => {
      dropdown.querySelectorAll('.cb295-chat-mention-item').forEach((it, i) => {
        const matches = it.dataset.studentId === item.dataset.studentId;
        it.classList.toggle('cb295-chat-mention-item-active', matches);
        if (matches) _bmeMentionState && (_bmeMentionState.activeIdx = i);
      });
    });
  });
}

function hideBmeMentionDropdown() {
  _bmeMentionState = null;
  const dropdown = document.getElementById('cb295-chat-mention-dropdown');
  if (dropdown) { dropdown.hidden = true; dropdown.innerHTML = ''; }
}

/** Replace the in-progress @prefix with @canonicalToken + a trailing space. */
function applyBmeMention(studentId) {
  if (!_bmeMentionState) return;
  const { idToToken } = bmeBuildMentionIndex();
  const token = idToToken.get(studentId);
  if (!token) { hideBmeMentionDropdown(); return; }
  const ta = document.getElementById('cb295-chat-input');
  if (!ta) return;
  const cursor = ta.selectionStart;
  const before = ta.value.slice(0, _bmeMentionState.startIdx);
  const after = ta.value.slice(cursor);
  const mention = '@' + token + ' ';
  ta.value = before + mention + after;
  const nextPos = before.length + mention.length;
  ta.selectionStart = ta.selectionEnd = nextPos;
  hideBmeMentionDropdown();
  ta.focus();
}

/** Profile-view modal — read-only view of any roster entry's profile.
 * Shows photo, name, pronouns, campus, high school, bio, BME interest,
 * and the 5-day group rotation. Pulls the user doc on-demand and caches
 * it in `_bmeOtherProfileCache` so repeated opens are instant.
 */
async function openBmeProfileViewModal(studentId) {
  const roster = Array.isArray(_classData?.studentRoster) ? _classData.studentRoster : [];
  const entry = roster.find(s => s.id === studentId);
  if (!entry) return;

  closeBmeProfileViewModal();
  const modal = document.createElement('div');
  modal.id = 'cb295-profile-view-modal';
  modal.className = 'cb295-modal-overlay';
  const placeholder = (entry.name || '?').charAt(0);
  modal.innerHTML = `
    <div class="cb295-modal cb295-profile-view-modal" role="dialog" aria-modal="true" aria-labelledby="cb295-profile-view-title">
      <button type="button" class="cb295-modal-close" id="cb295-profile-view-close" aria-label="Close">&times;</button>
      <h3 id="cb295-profile-view-title">${esc((entry.name || '').split(',')[0])}</h3>
      <div class="cb295-profile-view-body">
        <div class="cb295-profile-view-photo" id="cb295-profile-view-photo">
          <div class="cb295-mate-photo cb295-mate-photo-blank">${esc(placeholder)}</div>
        </div>
        <dl class="cb295-profile-view-fields">
          <dt>Name</dt><dd>${esc(entry.name || '—')}</dd>
          ${entry.pronouns ? `<dt>Pronouns</dt><dd>${esc(entry.pronouns)}</dd>` : ''}
          <dt>Campus</dt><dd>${esc(entry.campus || '—')}</dd>
          ${entry.highSchool ? `<dt>High school</dt><dd>${esc(entry.highSchool)}</dd>` : ''}
          <dt>Daily groups</dt><dd>${bmeCourseDays().map(d => {
            const g = bmeGetGroupForDay(entry, d);
            return `<span class="cb295-daily-chip"><span class="cb295-daily-chip-day">${esc(d.slice(0,3))}</span><span class="cb295-daily-chip-num">${g ? '#' + esc(String(g)) : '—'}</span></span>`;
          }).join('')}</dd>
          <dt>Bio</dt><dd id="cb295-profile-view-bio"><em class="muted-text">Loading…</em></dd>
          <dt>BME interest</dt><dd id="cb295-profile-view-interest"><em class="muted-text">Loading…</em></dd>
        </dl>
      </div>
      <div class="cb295-modal-footer">
        ${_viewType === 'admin'
          ? `<button type="button" class="btn btn-secondary" id="cb295-profile-view-edit">Edit as admin</button>`
          : ''}
        <button type="button" class="btn" id="cb295-profile-view-done">Close</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  const close = () => closeBmeProfileViewModal();
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  document.getElementById('cb295-profile-view-close')?.addEventListener('click', close);
  document.getElementById('cb295-profile-view-done')?.addEventListener('click', close);
  // V3.261 — admin moderation edit. Pulls the target uid from the
  // cached profile (stamped during the lookup below). If the cache
  // doesn't have a _uid yet (lookup still in flight), we fall back to a
  // one-shot email query before opening the modal.
  document.getElementById('cb295-profile-view-edit')?.addEventListener('click', async () => {
    let targetUid = _bmeOtherProfileCache.get(entry.id)?._uid;
    if (!targetUid && entry.email) {
      try {
        const snap = await McgheeLab.db.collection('users')
          .where('email', '==', (entry.email || '').toLowerCase()).limit(1).get();
        if (!snap.empty) targetUid = snap.docs[0].id;
      } catch (e) { /* fall through; alert below */ }
    }
    if (!targetUid) {
      alert(`Can't edit ${entry.name}'s profile — they need to sign in at least once first so a user record exists.`);
      return;
    }
    closeBmeProfileViewModal();
    openBmeBioModal({ targetUid, targetEntry: entry, targetName: entry.name, targetEmail: entry.email });
  });

  // Look up the user's profile (bio, photo) by email. Prefer dashboard
  // cache if available; otherwise query directly. Anonymous entries on
  // the chat are still resolved against the same source.
  const email = (entry.email || '').toLowerCase();
  if (!email) {
    document.getElementById('cb295-profile-view-bio').innerHTML = '<em class="muted-text">No email on file.</em>';
    document.getElementById('cb295-profile-view-interest').innerHTML = '';
    return;
  }
  let prof = _bmeOtherProfileCache.get(entry.id)
    || _bmeDashboardData?.profilesByEmail?.get(email)?.bme295c
    || null;
  let fetchedFreshly = false;
  if (!prof) {
    // V3.254 — try lowercase email first (matches Google auth's stored
    // form), then fall back to the as-typed entry.email in case the
    // user-doc was written with mixed case.
    const tryEmails = [email];
    if (entry.email && entry.email !== email) tryEmails.push(entry.email);
    let foundUid = null;
    for (const e of tryEmails) {
      try {
        const snap = await McgheeLab.db.collection('users').where('email', '==', e).limit(1).get();
        if (!snap.empty) {
          prof = snap.docs[0].data()?.bme295c || null;
          foundUid = snap.docs[0].id;
          if (prof) break;
        }
      } catch (err) { /* try next */ }
    }
    if (prof) {
      // V3.261 — include _uid so the admin "Edit as admin" button can
      // target users/{uid} directly without another email lookup.
      _bmeOtherProfileCache.set(entry.id, { ...prof, _uid: foundUid });
      fetchedFreshly = true;
    }
  }
  const bioEl = document.getElementById('cb295-profile-view-bio');
  const interestEl = document.getElementById('cb295-profile-view-interest');
  const photoBox = document.getElementById('cb295-profile-view-photo');
  if (prof?.photoUrl && photoBox) {
    photoBox.innerHTML = `<img src="${esc(prof.photoUrl)}" alt="${esc(entry.name)}" />`;
  }
  if (bioEl) bioEl.innerHTML = prof?.bio ? esc(prof.bio).replace(/\n/g, '<br>') : '<em class="muted-text">No bio yet.</em>';
  if (interestEl) interestEl.innerHTML = prof?.interest ? esc(prof.interest).replace(/\n/g, '<br>') : '<em class="muted-text">No interest entered.</em>';
  // V3.254 — if we just pulled a fresh profile with a photo, refresh
  // the chat sidebar so the avatar updates without requiring a full
  // page navigation.
  if (fetchedFreshly && prof?.photoUrl) {
    refreshBmeChatMembersAside();
  }
}

function closeBmeProfileViewModal() {
  document.getElementById('cb295-profile-view-modal')?.remove();
}

async function sendBmeChatMessage(messageType) {
  const auth = McgheeLab.Auth;
  if (!auth?.currentUser) {
    alert('Sign in to participate in the chat.');
    return;
  }
  const ta = document.getElementById('cb295-chat-input');
  const anonCb = document.getElementById('cb295-chat-anon');
  const text = (ta?.value || '').trim();
  if (!text) return;
  if (text.length > 2000) {
    alert('Please keep messages under 2000 characters.');
    return;
  }
  const anonymous = !!anonCb?.checked;
  const entry = _bmeRosterEntry;
  const authorName = entry?.name
    || auth.currentUser.displayName
    || (auth.currentUser.email ? auth.currentUser.email.split('@')[0] : 'someone');

  // V3.251 — extract @-mentions so the highlight-when-mentioned UI has
  // a clean array to check against, instead of re-parsing the text on
  // every render.
  const { mentionedIds } = bmeExtractMentions(text);

  // V3.261 — denormalize the author's photo URL onto the message doc so
  // every viewer (including those without the dashboard cache loaded)
  // can render a bubble avatar with zero extra Firestore reads. Also
  // covers non-roster authors (admins) whose photos aren't in
  // `_bmeOtherProfileCache`.
  const authorPhotoUrl = (!anonymous && _bmeProfile?.photoUrl) ? _bmeProfile.photoUrl : '';

  const payload = {
    text,
    messageType: messageType === 'raised_hand' ? 'raised_hand' : 'message',
    anonymous,
    authorUid: auth.currentUser.uid,
    authorName,
    authorEmail: (auth.currentUser.email || '').toLowerCase(),
    authorPhotoUrl,
    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    speakerSlug: bmeCurrentLiveSpeaker(),
    mentions: mentionedIds,
    answered: false,
    answeredBy: null,
    answeredAt: null
  };
  if (_classData?.testMode === true) payload.testMode = true;

  // Optimistic UI: clear the textarea + checkbox immediately. The
  // onSnapshot listener will append the doc when the server confirms.
  if (ta) ta.value = '';
  if (anonCb) anonCb.checked = false;
  _bmeChatScrollPinned = true;

  try {
    await McgheeLab.db.collection('schedules').doc(_scheduleId)
      .collection('classQA').add(payload);
  } catch (e) {
    console.error('[BME295C chat] send failed', e);
    alert('Message failed to send: ' + (e.message || e));
    // Restore the textarea text so the user can retry.
    if (ta) ta.value = text;
  }
}

async function markBmeQuestionAnswered(msgId, value) {
  const auth = McgheeLab.Auth;
  if (!auth?.currentUser) return;
  try {
    await McgheeLab.db.collection('schedules').doc(_scheduleId)
      .collection('classQA').doc(msgId).set({
        answered: !!value,
        answeredBy: value ? auth.currentUser.uid : null,
        answeredAt: value ? firebase.firestore.FieldValue.serverTimestamp() : null
      }, { merge: true });
  } catch (e) {
    console.error('[BME295C chat] mark-answered failed', e);
    alert('Update failed: ' + (e.message || e));
  }
}

function wireBme295cRoster() {
  // Email / campus / high school / daily-group inputs → write back to _classData.studentRoster + mark dirty
  document.querySelectorAll('.cb295-roster-email, .cb295-roster-campus, .cb295-roster-highschool, .cb295-roster-daily').forEach(el => {
    el.addEventListener('change', () => {
      const idx = parseInt(el.dataset.idx, 10);
      const entry = _classData.studentRoster?.[idx];
      if (!entry) return;
      if (el.classList.contains('cb295-roster-email'))      entry.email = el.value.trim();
      if (el.classList.contains('cb295-roster-campus'))     entry.campus = el.value;
      if (el.classList.contains('cb295-roster-highschool')) entry.highSchool = el.value.trim();
      if (el.classList.contains('cb295-roster-daily')) {
        const day = el.dataset.day;
        const v = parseInt(el.value, 10);
        if (!entry.dailyGroups || typeof entry.dailyGroups !== 'object') entry.dailyGroups = {};
        if (Number.isFinite(v)) entry.dailyGroups[day] = v;
        else delete entry.dailyGroups[day];
        // Keep legacy groupNumber synced to the first course day for back-compat.
        const days = bmeCourseDays();
        entry.groupNumber = (typeof entry.dailyGroups[days[0]] === 'number') ? entry.dailyGroups[days[0]] : null;
      }
      markDirty();
    });
  });

  // V3.277 — Expand all / Collapse all for the per-row Details cells.
  document.getElementById('cb295-roster-expand-all')?.addEventListener('click', () => {
    document.querySelectorAll('.cb295-roster-extras').forEach(d => { d.open = true; });
  });
  document.getElementById('cb295-roster-collapse-all')?.addEventListener('click', () => {
    document.querySelectorAll('.cb295-roster-extras').forEach(d => { d.open = false; });
  });

  // Auto-assign rotated daily groups
  document.getElementById('cb295-auto-assign')?.addEventListener('click', () => {
    autoAssignBme295cGroups();
    markDirty();
    persistAll().then(() => refreshCanvas());
  });

  document.getElementById('cb295-clear-groups')?.addEventListener('click', () => {
    if (!confirm('Clear all daily group assignments? (Campus assignments are kept.)')) return;
    (_classData.studentRoster || []).forEach(s => { s.groupNumber = null; s.dailyGroups = {}; });
    markDirty();
    persistAll().then(() => refreshCanvas());
  });

  document.getElementById('cb295-add-test-students')?.addEventListener('click', () => {
    addBmeTestStudents();
    markDirty();
    persistAll().then(() => refreshCanvas());
  });

  document.getElementById('cb295-clear-test-students')?.addEventListener('click', () => {
    if (!confirm('Remove all test students (id prefix "TEST_")?')) return;
    _classData.studentRoster = (_classData.studentRoster || []).filter(s => !(typeof s.id === 'string' && s.id.startsWith('TEST_')));
    markDirty();
    persistAll().then(() => refreshCanvas());
  });

  // ── Manual add-student (V3.249) ──
  document.getElementById('cb295-add-student')?.addEventListener('click', () => {
    openBmeAddStudentModal();
  });
  // Per-row remove (× button on the right of each row)
  document.querySelectorAll('.cb295-roster-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.idx, 10);
      const entry = _classData.studentRoster?.[idx];
      if (!entry) return;
      if (!confirm(`Remove ${entry.name || entry.id} from the roster?`)) return;
      _classData.studentRoster.splice(idx, 1);
      markDirty();
      persistAll().then(() => refreshCanvas());
    });
  });

  // V3.251 — per-row "View as" button (moved here from the deleted
  // student-grid panel). Switches the View-as toolbar to impersonate.
  document.querySelectorAll('.cb295-roster-viewas').forEach(btn => {
    btn.addEventListener('click', async () => {
      const studentId = btn.dataset.studentId;
      if (!studentId) return;
      await setAdminViewOverride({ type: 'student', studentId });
    });
  });

  // ── Class admins (V3.247) ──
  document.getElementById('cb295-classadmin-add-form')?.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const input = document.getElementById('cb295-classadmin-add-email');
    const raw = (input?.value || '').trim();
    if (!raw) return;
    // Very light validation — Firebase auth will only let real Google
    // accounts in, so the worst case for a typo is the recipient can't
    // actually sign in and the admin retries.
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(raw)) {
      alert('That doesn\'t look like an email address.');
      return;
    }
    const email = raw.toLowerCase();
    if (!Array.isArray(_classData.classAdminEmails)) _classData.classAdminEmails = [];
    if (_classData.classAdminEmails.map(e => e.toLowerCase()).includes(email)) {
      alert('That email is already a class admin.');
      return;
    }
    _classData.classAdminEmails.push(email);
    markDirty();
    persistAll().then(() => refreshCanvas());
  });

  document.querySelectorAll('.cb295-classadmin-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      const email = (btn.dataset.classadminEmail || '').toLowerCase();
      if (!email) return;
      if (!confirm(`Remove ${email} as a class admin?`)) return;
      _classData.classAdminEmails = (_classData.classAdminEmails || [])
        .filter(e => (e || '').toLowerCase() !== email);
      markDirty();
      persistAll().then(() => refreshCanvas());
    });
  });

  document.querySelectorAll('.cb295-classadmin-copy').forEach(btn => {
    btn.addEventListener('click', async () => {
      const url = btn.dataset.inviteUrl || '';
      const email = btn.dataset.classadminEmail || '';
      const msg = `You've been added as a class admin for BME 295C. Sign in at:\n${url}\n\nUse the email ${email} when signing in.`;
      const flash = (text, ok = true) => {
        const orig = btn.textContent;
        btn.textContent = text;
        btn.classList.toggle('cb295-classadmin-copy-ok', ok);
        setTimeout(() => {
          btn.textContent = orig;
          btn.classList.remove('cb295-classadmin-copy-ok');
        }, 1800);
      };
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(msg);
          flash('Copied!');
        } else {
          // Fallback: temporary textarea + execCommand
          const ta = document.createElement('textarea');
          ta.value = msg; ta.style.position = 'fixed'; ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          const ok = document.execCommand('copy');
          ta.remove();
          flash(ok ? 'Copied!' : 'Copy failed', ok);
        }
      } catch (e) {
        console.error('[BME295C] clipboard copy failed', e);
        flash('Copy failed', false);
      }
    });
  });
}

/** Inject 4 fake students for debugging the rotation / dashboard. Marked
 * with id prefix `TEST_` so `Clear test students` can scrub them.
 * Idempotent: if any TEST_* ids already exist, just adds 4 more with
 * unique IDs (incrementing counter).
 */
function addBmeTestStudents() {
  if (!_classData.studentRoster) _classData.studentRoster = [];
  const existing = _classData.studentRoster.filter(s =>
    typeof s.id === 'string' && s.id.startsWith('TEST_'));
  // Find next index based on existing TEST_N ids.
  let nextIdx = 1;
  for (const s of existing) {
    const m = /^TEST_(\d+)$/.exec(s.id);
    if (m) nextIdx = Math.max(nextIdx, parseInt(m[1], 10) + 1);
  }
  const sampleHs = ['Test High Tucson', 'Test High Phoenix', 'Test Prep Academy', 'Test STEM HS'];
  for (let i = 0; i < 4; i++) {
    const n = nextIdx + i;
    const campus = (i % 2 === 0) ? 'Tucson' : 'Phoenix';
    _classData.studentRoster.push({
      id: `TEST_${n}`,
      name: `Test, Student ${n}`,
      pronouns: '',
      email: `test.student${n}@local.test`,
      campus,
      highSchool: sampleHs[i % sampleHs.length],
      groupNumber: null,
      dailyGroups: {}
    });
  }
}

/* ─── Daily attendance (V3.279) ────────────────────────────────
   Per-class-day attendance map on the schedule doc:
     dailyAttendance: { [day]: { presentIds: [id…], absentIds: [id…],
                                 recordedAt, recordedBy } }
   When admin records attendance for a day, the single-day assignment
   function (`autoAssignBmeSingleDay`) filters that campus's members
   down to only the present students. Absent students get
   `dailyGroups[day]` cleared (no group for that day).
   ─────────────────────────────────────────────────────────── */

function bmeGetDailyAttendance(day) {
  const m = _classData?.dailyAttendance;
  if (!m || !day || !m[day]) return null;
  return m[day];
}

/** True when the student is on the present list for that day, OR no
 * attendance has been recorded yet (default-present so the existing
 * all-days rotation still works without an attendance pass). */
function bmeIsPresentOnDay(studentId, day) {
  const att = bmeGetDailyAttendance(day);
  if (!att) return true;
  if (Array.isArray(att.presentIds) && att.presentIds.includes(studentId)) return true;
  if (Array.isArray(att.absentIds) && att.absentIds.includes(studentId)) return false;
  // Recorded but student not in either list (e.g., added to roster after
  // attendance was taken) — default-present so they're not silently
  // dropped from group assignment.
  return true;
}

/* ─── Gradebook helpers (V3.280) ──────────────────────────────
   Per-student composite grade from three signals:
   1. Attendance — derived from `_classData.dailyAttendance` (V3.279).
      Grading uses EXPLICIT-present semantics (override of
      `bmeIsPresentOnDay`'s default-present) so a no-show doesn't get
      100% just because the admin hasn't recorded that day yet.
   2. Discussion — derived from `groupResponses/{id}.attendance.presentIds`
      (V3.252) gated by submitted status + group-quality stars.
   3. Alertness — manual per-student-per-talk 1/2/3 rating on
      `_classData.grades.alertness[slug][rosterId].rating`.
   All grade-only state lives at `_classData.grades.*` (admin-editable
   schedule field). Public read of the schedule doc means comments are
   technically readable by anyone signed in; v1 trust model matches
   V3.244 / V3.247 / V3.279 precedent.
   ─────────────────────────────────────────────────────────── */

function bmeGetGradesObj() {
  if (!_classData) return null;
  if (!_classData.grades || typeof _classData.grades !== 'object') {
    _classData.grades = { weights: {}, alertness: {}, discussionQuality: {}, comments: {}, excused: {} };
  }
  // Defensive backfill for any sub-map that's missing (e.g., from a
  // partial older write).
  const g = _classData.grades;
  if (!g.weights || typeof g.weights !== 'object') g.weights = {};
  if (!g.alertness || typeof g.alertness !== 'object') g.alertness = {};
  if (!g.discussionQuality || typeof g.discussionQuality !== 'object') g.discussionQuality = {};
  if (!g.comments || typeof g.comments !== 'object') g.comments = {};
  if (!g.excused || typeof g.excused !== 'object') g.excused = {};
  return g;
}

/** Normalized weight map. Reads `_classData.grades.weights`, fills any
 * missing keys with defaults, and proportionally scales so the three
 * weights sum to exactly 100. The on-screen weight inputs show the
 * raw stored value (so the admin's "50/25/30 = 105" intent isn't
 * silently lost) but the composite math uses the normalized version.
 */
function bmeGradeWeights() {
  const g = bmeGetGradesObj() || {};
  const raw = g.weights || {};
  const w = {
    attendance: Number.isFinite(raw.attendance) ? Number(raw.attendance) : 40,
    discussion: Number.isFinite(raw.discussion) ? Number(raw.discussion) : 30,
    alertness:  Number.isFinite(raw.alertness)  ? Number(raw.alertness)  : 30
  };
  const sum = w.attendance + w.discussion + w.alertness;
  if (sum <= 0) return { attendance: 40, discussion: 30, alertness: 30, _raw: w, _sum: 0 };
  if (Math.abs(sum - 100) < 0.01) return { ...w, _raw: w, _sum: sum };
  return {
    attendance: (w.attendance / sum) * 100,
    discussion: (w.discussion / sum) * 100,
    alertness:  (w.alertness  / sum) * 100,
    _raw: w,
    _sum: sum
  };
}

/** Test-roster filter. Excludes `TEST_*` injected rows from the gradebook
 * + CSV export so debug data doesn't pollute the grade list. The user
 * has a `+ Add 4 test students` button (V3.246) that uses this prefix. */
function bmeIsTestRosterEntry(s) {
  return typeof s?.id === 'string' && s.id.startsWith('TEST_');
}

/** EXPLICIT-present semantics for grading. Returns true ONLY when the
 * student is on the day's `presentIds` list. Missing attendance entry
 * for the day → returns false (override of `bmeIsPresentOnDay`'s
 * default-present, which is correct for assignment but wrong for
 * grading — no record shouldn't auto-credit attendance). */
function bmeIsPresentForGrade(studentId, day) {
  const att = bmeGetDailyAttendance(day);
  if (!att || !Array.isArray(att.presentIds)) return false;
  return att.presentIds.includes(studentId);
}

/** Reads `_classData.grades.excused[rosterId][day]`. Excused days are
 * removed from BOTH the numerator and denominator of attendance %. */
function bmeIsExcused(studentId, day) {
  const g = bmeGetGradesObj();
  return !!g?.excused?.[studentId]?.[day];
}

/** Free-rider check: did this student earn discussion credit for this
 * talk? Requires (a) a submitted groupResponse doc + (b) the student's
 * id on its `attendance.presentIds`. Older docs may not have an
 * `attendance` field — in that case fall back to NO credit, so the
 * default isn't "everyone gets credit if anyone in the group submits."
 */
function bmeStudentGotDiscussionCredit(student, slug) {
  const day = bmeSpeakerDay(slug);
  const group = bmeGetGroupForDay(student, day);
  if (!group) return false;
  // V3.284 — bmeStudentCampus, not raw student.campus, so the override
  // case lines up with where the save path wrote the doc.
  const docId = bmeResponseDocId(bmeStudentCampus(student), group, slug);
  const r = _bmeDashboardData?.responses?.get(docId);
  if (!r) return false;
  if (r.status !== 'submitted') return false;
  const presentIds = r.attendance?.presentIds;
  if (!Array.isArray(presentIds)) return false;
  return presentIds.includes(student.id);
}

/** V3.281 — alertness is now keyed by DAY, not speaker slug. Admin
 * rates engagement once per (student × day) inside the Daily Attendance
 * panel (right next to the present/absent checkbox), instead of once
 * per (student × talk) inside the gradebook matrix. 5 ratings per
 * student instead of 10, and the rating sits where the admin already
 * has eyes on the student for attendance. */
function bmeGetAlertness(day, rosterId) {
  const g = bmeGetGradesObj();
  const v = g?.alertness?.[day]?.[rosterId];
  if (!v || typeof v !== 'object') return null;
  const r = Number(v.rating);
  return (r === 1 || r === 2 || r === 3) ? r : null;
}

function bmeGetDiscussionQuality(campus, group, slug) {
  const g = bmeGetGradesObj();
  const key = `${campus}-${group}-${slug}`;
  const v = g?.discussionQuality?.[key];
  if (!v || typeof v !== 'object') return null;
  const s = Number(v.stars);
  return (s === 1 || s === 2 || s === 3) ? s : null;
}

function bmeGetStudentComment(rosterId) {
  const g = bmeGetGradesObj();
  return g?.comments?.[rosterId]?.text || '';
}

async function bmeSetAlertness(day, rosterId, rating) {
  const g = bmeGetGradesObj();
  if (!g) return;
  const r = (rating === 1 || rating === 2 || rating === 3) ? rating : null;
  const auth = McgheeLab.Auth;
  if (!g.alertness[day]) g.alertness[day] = {};
  if (r === null) {
    delete g.alertness[day][rosterId];
  } else {
    g.alertness[day][rosterId] = {
      rating: r,
      ratedBy: auth?.currentUser?.uid || null,
      ratedAt: firebase.firestore.FieldValue.serverTimestamp()
    };
  }
  markDirty();
  try { await persistAll(); } catch (e) { alert('Save failed: ' + (e.message || e)); return; }
  refreshCanvas();
}

async function bmeSetDiscussionQuality(campus, group, slug, stars) {
  const g = bmeGetGradesObj();
  if (!g) return;
  const s = (stars === 1 || stars === 2 || stars === 3) ? stars : null;
  const auth = McgheeLab.Auth;
  const key = `${campus}-${group}-${slug}`;
  if (s === null) {
    delete g.discussionQuality[key];
  } else {
    g.discussionQuality[key] = {
      stars: s,
      gradedBy: auth?.currentUser?.uid || null,
      gradedAt: firebase.firestore.FieldValue.serverTimestamp()
    };
  }
  markDirty();
  try { await persistAll(); } catch (e) { alert('Save failed: ' + (e.message || e)); return; }
  refreshCanvas();
}

async function bmeSetStudentComment(rosterId, text) {
  const g = bmeGetGradesObj();
  if (!g) return;
  const t = (text || '').trim();
  const auth = McgheeLab.Auth;
  if (!t) {
    delete g.comments[rosterId];
  } else {
    g.comments[rosterId] = {
      text: t,
      updatedBy: auth?.currentUser?.uid || null,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    };
  }
  markDirty();
  try { await persistAll(); } catch (e) { alert('Save failed: ' + (e.message || e)); return; }
  // Comment edits don't change the composite display, so skip the full
  // canvas refresh — the textarea's value is already correct in the DOM.
}

async function bmeSetExcused(rosterId, day, bool) {
  const g = bmeGetGradesObj();
  if (!g) return;
  if (!g.excused[rosterId]) g.excused[rosterId] = {};
  if (bool) g.excused[rosterId][day] = true;
  else delete g.excused[rosterId][day];
  if (!Object.keys(g.excused[rosterId]).length) delete g.excused[rosterId];
  markDirty();
  try { await persistAll(); } catch (e) { alert('Save failed: ' + (e.message || e)); return; }
  refreshCanvas();
}

async function bmeSetGradeWeights(attendance, discussion, alertness) {
  const g = bmeGetGradesObj();
  if (!g) return;
  g.weights = {
    attendance: Number.isFinite(Number(attendance)) ? Number(attendance) : 40,
    discussion: Number.isFinite(Number(discussion)) ? Number(discussion) : 30,
    alertness:  Number.isFinite(Number(alertness))  ? Number(alertness)  : 30
  };
  markDirty();
  try { await persistAll(); } catch (e) { alert('Save failed: ' + (e.message || e)); return; }
  refreshCanvas();
}

/** Compute the full grade breakdown for a student. Returns an object
 * with the three sub-scores (att / disc / alert ∈ [0,1] or null when
 * not applicable), a composite total ∈ [0,100], and a `perTalk` array
 * with the data needed to render the per-student detail modal. */
function bmeComputeStudentGrade(student) {
  const days = bmeCourseDays();
  const speakers = (_bmeContent?.speakers || []);

  // --- Attendance % ---
  const counted = days.filter(d => !bmeIsExcused(student.id, d));
  const presentDays = counted.filter(d => bmeIsPresentForGrade(student.id, d));
  const att = counted.length ? (presentDays.length / counted.length) : 1;

  // --- Discussion % (walk speakers once) ---
  let discNumerator = 0;   // accumulated point fraction
  let discDenominator = 0; // talks where the student has a group assigned
  const perTalk = [];

  speakers.forEach(sp => {
    const slug = sp.slug;
    // V3.284 — drop the `sp.day ||` fallback (same date-suffix issue).
    const day = bmeSpeakerDay(slug);
    const group = bmeGetGroupForDay(student, day);
    const credited = bmeStudentGotDiscussionCredit(student, slug);
    // V3.284 — use bmeStudentCampus so the override case routes to the
    // same campus bucket the student's save path wrote to.
    const studentCampus = bmeStudentCampus(student);
    const stars = group ? bmeGetDiscussionQuality(studentCampus, group, slug) : null;
    const presentForGrade = bmeIsPresentForGrade(student.id, day);
    const excused = bmeIsExcused(student.id, day);
    // pointFraction: 0 if not credited; if credited, full credit when
    // ungraded (null) or stars/3 when graded.
    const pointFraction = credited
      ? (stars == null ? 1.0 : stars / 3)
      : 0;
    if (group) {
      discNumerator += pointFraction;
      discDenominator += 1;
    }

    perTalk.push({
      slug, day,
      campus: studentCampus,
      group,
      credited,
      stars,
      presentForGrade,
      excused,
      response: group ? _bmeDashboardData?.responses?.get(bmeResponseDocId(studentCampus, group, slug)) || null : null
    });
  });

  // --- Alertness % (V3.281 — per-day, not per-talk) ---
  const alertVals = [];
  const perDay = [];
  days.forEach(d => {
    const r = bmeGetAlertness(d, student.id);
    perDay.push({ day: d, rating: r });
    if (r !== null) alertVals.push(r);
  });

  const disc = discDenominator ? (discNumerator / discDenominator) : 0;
  const alert = alertVals.length ? (alertVals.reduce((a, b) => a + b, 0) / alertVals.length / 3) : null;

  // --- Composite ---
  const w = bmeGradeWeights();
  let total;
  if (alert === null) {
    // Redistribute the alertness weight proportionally to att + disc so
    // an admin who hasn't rated anyone doesn't see "20 free points" or
    // a low ceiling — the grade just reflects what's been measured.
    const redistTotal = w.attendance + w.discussion;
    if (redistTotal > 0) {
      total = (att * w.attendance + disc * w.discussion) * (100 / redistTotal);
    } else {
      total = 0;
    }
  } else {
    total = att * w.attendance + disc * w.discussion + alert * w.alertness;
  }
  total = Math.max(0, Math.min(100, Math.round(total)));

  return { att, disc, alert, total, perTalk, perDay, presentDays: presentDays.length, countedDays: counted.length, discDenominator };
}

/** Build a CSV from non-test roster entries: name, email, campus,
 * att%, disc%, alert%, total%, comment. Encodes commas + quotes per
 * RFC 4180. Returns the string; caller is responsible for the
 * download trigger.
 */
function bmeGradesToCSV() {
  const roster = Array.isArray(_classData?.studentRoster) ? _classData.studentRoster : [];
  const escapeCsv = (s) => {
    const str = (s == null ? '' : String(s));
    if (/[",\n\r]/.test(str)) return '"' + str.replace(/"/g, '""') + '"';
    return str;
  };
  const headers = ['Name', 'Email', 'Campus', 'Att%', 'Disc%', 'Alert%', 'Total%', 'Comment'];
  const lines = [headers.join(',')];
  roster
    .filter(s => !bmeIsTestRosterEntry(s))
    .map(s => ({ s, g: bmeComputeStudentGrade(s) }))
    .sort((a, b) => b.g.total - a.g.total)
    .forEach(({ s, g }) => {
      const pct = (x) => (x == null ? '' : Math.round(x * 100));
      lines.push([
        escapeCsv(s.name),
        escapeCsv(s.email),
        escapeCsv(s.campus),
        pct(g.att),
        pct(g.disc),
        pct(g.alert),
        g.total,
        escapeCsv(bmeGetStudentComment(s.id))
      ].join(','));
    });
  return lines.join('\n');
}

/** Reassign a single day's groups, respecting attendance + maintaining
 * the rotation against any other days already assigned. Absent students
 * get `dailyGroups[day]` cleared. Pair-count score is built from every
 * OTHER day's existing assignments (not just prior — so a re-assign of
 * Wednesday after Mon/Tue/Thu/Fri are set still minimizes overlap).
 */
function autoAssignBmeSingleDay(day) {
  if (!day) return;
  const roster = _classData?.studentRoster || [];
  const days = bmeCourseDays();
  if (!days.includes(day)) return;
  const TRIALS = 400;

  ['Tucson', 'Phoenix'].forEach(campus => {
    const campusMembers = roster.filter(s => s.campus === campus);
    if (!campusMembers.length) return;
    const present = campusMembers.filter(s => bmeIsPresentOnDay(s.id, day));

    // Clear the day's assignment for every campus member first — absent
    // students stay null; present students get a fresh assignment below.
    campusMembers.forEach(m => {
      if (!m.dailyGroups) m.dailyGroups = {};
      delete m.dailyGroups[day];
    });
    if (!present.length) return;

    const n = present.length;
    const numGroups = Math.max(1, Math.round(n / 3.5));
    const base = Math.floor(n / numGroups);
    const extras = n - base * numGroups;

    // Build pair-count from every OTHER day's existing assignments so
    // the re-roll for `day` still minimizes overlap with the rest of
    // the week. Counts pairs across the FULL campus roster (absent
    // students included) — accurate model of "who has worked with
    // whom" even if a student wasn't present today.
    const pairCounts = new Map();
    const pairKey = (a, b) => (a < b ? a + '|' + b : b + '|' + a);
    const getPair = (a, b) => pairCounts.get(pairKey(a, b)) || 0;
    const incrPair = (a, b) => pairCounts.set(pairKey(a, b), getPair(a, b) + 1);
    days.forEach(d => {
      if (d === day) return;
      const byGroup = new Map();
      campusMembers.forEach(m => {
        const g = m.dailyGroups?.[d];
        if (typeof g !== 'number') return;
        if (!byGroup.has(g)) byGroup.set(g, []);
        byGroup.get(g).push(m.id);
      });
      for (const ids of byGroup.values()) {
        for (let i = 0; i < ids.length; i++) {
          for (let j = i + 1; j < ids.length; j++) incrPair(ids[i], ids[j]);
        }
      }
    });

    const randomPartition = () => {
      const order = present.map((_, i) => i);
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
      const assignment = new Array(n);
      let cursor = 0;
      for (let g = 0; g < numGroups; g++) {
        const size = base + (g < extras ? 1 : 0);
        for (let k = 0; k < size; k++) { assignment[order[cursor]] = g + 1; cursor++; }
      }
      return assignment;
    };
    const scorePartition = (a) => {
      const byGroup = new Map();
      for (let i = 0; i < n; i++) {
        if (!byGroup.has(a[i])) byGroup.set(a[i], []);
        byGroup.get(a[i]).push(present[i].id);
      }
      let s = 0;
      for (const ids of byGroup.values()) {
        for (let i = 0; i < ids.length; i++) {
          for (let j = i + 1; j < ids.length; j++) s += getPair(ids[i], ids[j]);
        }
      }
      return s;
    };

    let best = null, bestScore = Infinity;
    for (let t = 0; t < TRIALS; t++) {
      const cand = randomPartition();
      const sc = scorePartition(cand);
      if (sc < bestScore) { bestScore = sc; best = cand; }
      if (sc === 0) break;
    }
    for (let i = 0; i < n; i++) {
      present[i].dailyGroups[day] = best[i];
    }
  });

  // Keep the legacy groupNumber (used by older callers) synced to the
  // first day's value when it exists.
  const day1 = days[0];
  (roster || []).forEach(m => {
    if (typeof m.dailyGroups?.[day1] === 'number') m.groupNumber = m.dailyGroups[day1];
  });
}

/** V3.279 — Save attendance for one day. Toggles the schedule's
 * `dailyAttendance[day]` entry and persists. Does NOT re-assign groups
 * automatically; the admin clicks "Assign {Day}'s groups" separately
 * so attendance edits don't accidentally shuffle existing assignments.
 */
async function setBmeDailyAttendance(day, presentIds, absentIds) {
  if (!_classData || !day) return;
  const auth = McgheeLab.Auth;
  if (!Array.isArray(_classData.dailyAttendance) && typeof _classData.dailyAttendance !== 'object') {
    _classData.dailyAttendance = {};
  }
  _classData.dailyAttendance = {
    ...(_classData.dailyAttendance || {}),
    [day]: {
      presentIds: presentIds.slice(),
      absentIds:  absentIds.slice(),
      recordedAt: firebase.firestore.FieldValue.serverTimestamp(),
      recordedBy: auth?.currentUser?.uid || null
    }
  };
  markDirty();
  try { await persistAll(); } catch (e) {
    alert('Could not save attendance: ' + (e.message || e));
    return;
  }
  refreshCanvas();
}

/** V3.279 — Run single-day assignment for a specific day, respecting
 * the just-saved attendance. Convenience wrapper used by the
 * "Assign {Day}'s groups" button on the attendance panel.
 */
async function assignBmeGroupsForDay(day) {
  autoAssignBmeSingleDay(day);
  markDirty();
  try { await persistAll(); } catch (e) {
    alert('Could not save group assignments: ' + (e.message || e));
    return;
  }
  refreshCanvas();
}

/** Generate per-day rotated groups for each campus.
 * For each campus and each course day, partitions the campus's students
 * into groups of 3-4. Rotation across days is optimized to minimize the
 * number of times any pair of students shares a group — heuristic:
 * for each day, try K random shuffles and keep the partition whose
 * total prior-pair-overlap score is lowest. Writes the assignment to
 * `entry.dailyGroups[day]` for every student in the campus pool. Also
 * mirrors Day 1's number to `entry.groupNumber` for legacy callers.
 *
 * V3.279 — when attendance has been recorded for any day, that day's
 * absent students still get assigned a group by this bulk path. Use
 * `autoAssignBmeSingleDay(day)` instead when you want per-day
 * attendance-aware assignment.
 */
function autoAssignBme295cGroups() {
  const roster = _classData.studentRoster || [];
  const days = bmeCourseDays();
  if (!days.length) return;

  const TRIALS_PER_DAY = 250;

  ['Tucson', 'Phoenix'].forEach(campus => {
    const members = roster.filter(s => s.campus === campus);
    const n = members.length;
    if (!n) return;

    const numGroups = Math.max(1, Math.round(n / 3.5));
    const base = Math.floor(n / numGroups);
    const extras = n - base * numGroups; // groups that get one extra

    // pairCounts[idA][idB] = number of prior days idA and idB shared a group.
    const pairCounts = new Map();
    const pairKey = (a, b) => (a < b ? a + '|' + b : b + '|' + a);
    const getPair = (a, b) => pairCounts.get(pairKey(a, b)) || 0;
    const incrPair = (a, b) => pairCounts.set(pairKey(a, b), getPair(a, b) + 1);

    const randomPartition = () => {
      // Fisher-Yates shuffle of indices.
      const order = members.map((_, i) => i);
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
      // Split into numGroups partitions of size base (+1 for the first `extras`).
      const assignment = new Array(n); // assignment[memberIdx] = groupNum
      let cursor = 0;
      for (let g = 0; g < numGroups; g++) {
        const size = base + (g < extras ? 1 : 0);
        for (let k = 0; k < size; k++) {
          assignment[order[cursor]] = g + 1;
          cursor++;
        }
      }
      return assignment;
    };

    const scorePartition = (assignment) => {
      // Sum of prior-pair counts within each group (lower = more novel pairings).
      const byGroup = new Map();
      for (let i = 0; i < n; i++) {
        const g = assignment[i];
        if (!byGroup.has(g)) byGroup.set(g, []);
        byGroup.get(g).push(members[i].id);
      }
      let s = 0;
      for (const ids of byGroup.values()) {
        for (let i = 0; i < ids.length; i++) {
          for (let j = i + 1; j < ids.length; j++) {
            s += getPair(ids[i], ids[j]);
          }
        }
      }
      return s;
    };

    // Ensure every member has a fresh dailyGroups object — we're replacing
    // the rotation from scratch.
    members.forEach(m => { m.dailyGroups = {}; });

    days.forEach((day, dayIdx) => {
      let best = null;
      let bestScore = Infinity;
      // Day 1 is unconstrained (no priors); fewer trials is fine.
      const trials = dayIdx === 0 ? 1 : TRIALS_PER_DAY;
      for (let t = 0; t < trials; t++) {
        const cand = randomPartition();
        const sc = scorePartition(cand);
        if (sc < bestScore) { bestScore = sc; best = cand; }
        if (sc === 0) break;
      }
      // Commit best partition to dailyGroups
      for (let i = 0; i < n; i++) {
        members[i].dailyGroups[day] = best[i];
      }
      // Update pair counts for the next day's scoring
      const byGroup = new Map();
      for (let i = 0; i < n; i++) {
        const g = best[i];
        if (!byGroup.has(g)) byGroup.set(g, []);
        byGroup.get(g).push(members[i].id);
      }
      for (const ids of byGroup.values()) {
        for (let i = 0; i < ids.length; i++) {
          for (let j = i + 1; j < ids.length; j++) {
            incrPair(ids[i], ids[j]);
          }
        }
      }
    });

    // Legacy fallback — `groupNumber` = first day's group.
    members.forEach(m => { m.groupNumber = m.dailyGroups[days[0]] ?? null; });
  });
}

/* ================================================================
   EXPORTS
   ================================================================ */
McgheeLab.renderClassPage    = renderClassPage;
McgheeLab.wireClassPage      = wireClassPage;
McgheeLab.renderClassEnrollPage = renderClassEnrollPage;
McgheeLab.wireClassEnrollPage   = wireClassEnrollPage;
McgheeLab.renderModuleViewer = renderModuleViewer;
McgheeLab.wireModuleViewer   = wireModuleViewer;
McgheeLab.ScheduleDB         = ScheduleDB;

})();
