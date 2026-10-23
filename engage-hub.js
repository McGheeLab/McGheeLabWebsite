/* ================================================================
   ENGAGEMENT HUB — #/engage (V3.673, teacher program R4)
   ----------------------------------------------------------------
   Where classroom outreach gets scheduled:

   • TEACHERS (category:'teacher') post an engagement listing (school,
     school type, grades, topics, activity types, formats) plus
     availability slots — weekly recurring and/or specific dates — and
     accept/decline the requests that come in. The school's street
     address lives in the owner-only private/contact subdoc and is copied
     onto a request ONLY when the teacher accepts it. That teacher panel
     is also the Engagement tab of the teaching hub (#/teach).

   • PRESENTERS — V3.785: anyone signed in through the link-only
     #/presenters page (engage-presenters.js) browses and requests. The
     old cap-gated browse view that lived here is gone; a non-teacher
     landing on #/engage is sent to #/presenters, so there is one
     presenter implementation.

   • ADMIN oversees everything from rm/pages/admin-teachers.html?tab=engage
     and is notified of every request (functions/engage-notify.js).

   ML.EngageKit exports the pieces both sides render with (labels, dates,
   slot expansion, the listing head, the month grid), so the presenter
   page and the teacher panel can't describe the same listing two ways.

   Data access rides teacher-classes.js's TC_DB + the same demo seam,
   so the #/demo engagement personas render this page on fixtures.
   No window.prompt/alert/confirm — inline armed confirms + a status
   line, as on #/teach.

   Loaded after teacher-teach.js, before engage-presenters.js and
   teacher-demo.js.
   ================================================================ */
(function () {
  'use strict';

  const ML = window.McgheeLab = window.McgheeLab || {};

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }
  function demo() { const d = ML.TC_DEMO; return (d && d.active) ? d : null; }
  function src() { return demo()?.db || ML.TC_DB; }
  function me() { return demo()?.uid || ML.Auth?.currentUser?.uid; }
  function myProfile() { return demo()?.profile || ML.Auth?.currentProfile || {}; }
  function waitForAuth() {
    const Auth = ML.Auth;
    if (!Auth || Auth._authStateResolved) return Promise.resolve();
    return new Promise(resolve => {
      const once = () => { Auth.offChange(once); resolve(); };
      Auth.onChange(once);
    });
  }

  const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const ACTIVITY_TYPES = [
    ['guest-talk', 'Guest talk'],
    ['demo', 'Demo / hands-on activity'],
    ['lab-tour', 'Lab tour'],
    ['career-chat', 'Career chat']
  ];
  const FORMATS = [
    ['at-school', 'In person at the school'],
    ['visit-uofa', 'Class visits UofA'],
    ['virtual', 'Virtual']
  ];
  // V3.785 — so presenters can tell a high-school class from a community-
  // college one. Listings saved before this have no schoolType ("not set").
  const SCHOOL_TYPES = [
    ['high-school', 'High school'],
    ['community-college', 'Community college'],
    ['other', 'Other']
  ];
  const label = (pairs, key) => (pairs.find(p => p[0] === key) || [key, key])[1];

  // V3.785 — LOCAL calendar dates. `toISOString()` is UTC: in Arizona
  // (UTC-7) it rolls over to tomorrow at 5pm, so "today" — and every date a
  // weekly slot expanded to — was a day ahead every evening.
  function isoLocal(d) {
    const dt = d instanceof Date ? d : new Date(d);
    const p = (n) => String(n).padStart(2, '0');
    return dt.getFullYear() + '-' + p(dt.getMonth() + 1) + '-' + p(dt.getDate());
  }
  function fromISO(iso) { const [y, m, d] = String(iso).split('-').map(Number); return new Date(y, m - 1, d); }
  function addDays(iso, n) { const d = fromISO(iso); d.setDate(d.getDate() + n); return isoLocal(d); }
  function todayISO() { return isoLocal(new Date()); }
  function fmtDay(d) {
    const dt = d ? new Date(d + 'T00:00') : null;
    return dt && !isNaN(dt)
      ? dt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) : d;
  }
  // The teacher panel writes into the OPEN step card's own status line,
  // so a message lands where the teacher is looking, not at the top of a
  // long page; anything else falls back to #eh-status.
  function setStatus(msg, isErr) {
    const el = document.querySelector('.eh-teacher .eh-step.open [data-step-status]') ||
      document.getElementById('eh-status');
    if (!el) return;
    el.textContent = msg || '';
    el.className = 'teach-status' + (isErr ? ' error-text' : '');
    el.hidden = !msg;
    clearTimeout(setStatus._t);
    if (msg && !isErr) setStatus._t = setTimeout(() => { el.hidden = true; }, 3500);
  }
  function armConfirm(btn, onYes) {
    if (btn.dataset.armed) return;
    btn.dataset.armed = '1';
    const original = btn.innerHTML;
    btn.innerHTML = 'Sure? <b>✓</b>';
    const cancel = document.createElement('button');
    cancel.type = 'button'; cancel.className = btn.className; cancel.textContent = '✕';
    btn.after(cancel);
    const restore = () => {
      clearTimeout(t); delete btn.dataset.armed;
      btn.innerHTML = original; cancel.remove();
      btn.removeEventListener('click', yes);
    };
    const t = setTimeout(restore, 6000);
    const yes = (e) => { e.stopPropagation(); restore(); onYes(); };
    btn.addEventListener('click', yes);
    cancel.addEventListener('click', (e) => { e.stopPropagation(); restore(); });
  }

  /* ---- month grid (V3.785) — shared by the teacher's availability
     calendar and the presenter page's calendar view. Pure HTML; the caller
     wires clicks by delegating on [data-day] / [data-cal-nav]. `days` maps
     'YYYY-MM-DD' → { chips: [{text, tone}], count, tone }. ---- */
  function monthGridHTML(opts) {
    const { year, month } = opts;
    const days = opts.days || {};
    const selected = opts.selected || new Set();
    const minISO = opts.minISO || '';
    const first = new Date(year, month, 1);
    const title = first.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    const cells = [];
    for (let i = 0; i < first.getDay(); i++) cells.push('<div class="eh-cal-cell is-pad" aria-hidden="true"></div>');
    const last = new Date(year, month + 1, 0).getDate();
    const today = todayISO();
    for (let n = 1; n <= last; n++) {
      const iso = isoLocal(new Date(year, month, n));
      const info = days[iso] || {};
      const past = iso < (minISO || today);
      const chips = (info.chips || []).slice(0, 3);
      const more = (info.chips || []).length - chips.length;
      cells.push(`
        <button type="button" class="eh-cal-cell${info.tone ? ' tone-' + info.tone : ''}${selected.has(iso) ? ' is-selected' : ''}${iso === today ? ' is-today' : ''}${past ? ' is-past' : ''}"
          data-day="${iso}"${past ? ' disabled' : ''} aria-pressed="${selected.has(iso) ? 'true' : 'false'}"
          aria-label="${esc(fmtDay(iso))}${info.label ? ': ' + esc(info.label) : ''}">
          <span class="eh-cal-n">${n}</span>
          ${info.count ? `<span class="eh-cal-count">${info.count}</span>` : ''}
          ${chips.map(c => `<span class="eh-cal-chip tone-${c.tone || 'open'}">${esc(c.text)}</span>`).join('')}
          ${more > 0 ? `<span class="eh-cal-more">+${more}</span>` : ''}
        </button>`);
    }
    return `
      <div class="eh-cal">
        <div class="eh-cal-bar">
          <button type="button" class="btn btn-secondary btn-small" data-cal-nav="-1"${opts.canPrev === false ? ' disabled' : ''} aria-label="Previous month">&larr;</button>
          <strong class="eh-cal-title">${esc(title)}</strong>
          <button type="button" class="btn btn-secondary btn-small" data-cal-nav="1"${opts.canNext === false ? ' disabled' : ''} aria-label="Next month">&rarr;</button>
        </div>
        <div class="eh-cal-grid" role="group" aria-label="${esc(title)}">
          ${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => `<div class="eh-cal-dow" aria-hidden="true">${d}</div>`).join('')}
          ${cells.join('')}
        </div>
        ${opts.legend ? `<div class="eh-cal-legend">${opts.legend.map(([tone, text]) =>
          `<span><i class="eh-cal-chip tone-${tone}"></i>${esc(text)}</span>`).join('')}</div>` : ''}
      </div>`;
  }

  /* ================================================================
     RENDER SKELETON + DISPATCH
     ================================================================ */
  function renderEngageHub() {
    return `<div class="dashboard-page teach-page" id="engage-root">
      <p class="loading-text">Loading the engagement hub…</p>
    </div>`;
  }

  async function wireEngageHub() {
    const root = document.getElementById('engage-root');
    if (!root) return;
    await waitForAuth();

    const signedIn = demo() ? !demo().signedOut : !!ML.Auth?.currentUser;
    const p = myProfile();
    if (signedIn && p.category === 'teacher') {
      await renderTeacherHub(root).catch(e => fail(root, e));
      return;
    }
    // V3.785 — everyone else (signed out, presenters, lab members) is a
    // presenter; replace() so Back doesn't bounce them here again.
    window.location.replace('#/presenters');
  }

  function fail(root, e) {
    console.warn('[ENGAGE]', e);
    root.innerHTML = `<div class="dash-card"><h3>Engagement Hub</h3>
      <p class="error-text">Failed to load: ${esc(e.message || e)}</p></div>`;
  }

  /* ================================================================
     TEACHER VIEW — seven step cards (V3.784)
     ----------------------------------------------------------------
     V3.769 — also MOUNTED as the Engagement tab of the teaching hub
     (#/teach/{id}/engagement) via ML.mountEngageTeacherPanel, so the
     two surfaces are one implementation and cannot drift. `opts`:
       embedded  — skip the page header (the host supplies one)
       classHint — {subject,size} filling a new slot's class context
                   where the listing (step 2) leaves a gap
       onChange  — host refresh to run after a request decision (the
                   host's tab badge counts pending requests)

     V3.784 — Alex: "make the engagement tab easier to walk through,
     make multiple cards for each section, so teachers can walk through
     it without losing their minds." The one long page (requests, a
     nine-field listing form with the address tucked in a <details>,
     availability, history) is now seven numbered cards, one open at a
     time, each ending in Back / Save & continue:

       Set up once:  1 You · 2 Your class · 3 Kinds of visit ·
                     4 Where visitors go · 5 Send it to the lab
       Ongoing:      6 When your class is free · 7 Visit requests

     A collapsed card shows a one-line summary of what it holds, so the
     stack doubles as the checklist. The listing is still ONE doc
     (engageProfiles/{uid}) spread over cards 1-3, and when it saves
     depends on where it stands:
       • not sent yet (none/draft) — each card saves a draft as you go,
         so leaving half-way loses nothing;
       • pending or approved — cards 1-3 do NOT write. An owner write can
         only land draft/pending (rules), so a per-card save would pull a
         live listing off the hub. Edits wait in `listingDraft` and go out
         from card 5 as one resubmission, with the unlisting spelled out.

     Nothing here is written by painting: paint() renders from loaded
     state + the two drafts, and every write is followed by reload().
     ================================================================ */
  const STEPS = [
    { id: 'about',    title: 'You and your school' },
    { id: 'class',    title: 'Your class' },
    { id: 'kinds',    title: 'Kinds of visit you want' },
    { id: 'location', title: 'Where visitors go' },
    { id: 'submit',   title: 'Send it to the lab' },
    { id: 'slots',    title: 'Your opportunities' },
    { id: 'visits',   title: 'Visit requests' }
  ];
  const SETUP_STEPS = ['about', 'class', 'kinds', 'location', 'submit'];
  const ACTIVITY_HINTS = {
    'guest-talk': 'A researcher talks about their work and takes questions',
    'demo': 'Something hands-on the class can try',
    'lab-tour': 'A walk through a working research lab',
    'career-chat': 'What the job is like and how people got there'
  };
  const FORMAT_HINTS = {
    'at-school': 'A researcher comes to your classroom',
    'visit-uofa': 'Your class comes to the university',
    'virtual': 'Over video'
  };
  const OPP_STATUS = {
    open: ['tc-chip-approved', 'open for sign-up'],
    paused: ['tc-chip-draft', 'paused'],
    booked: ['tc-chip-approved', 'booked'],
    closed: ['tc-chip-draft', 'closed']
  };

  // These survive a repaint AND the teaching hub's ctx.refresh() (which
  // remounts this panel), for the same reason teacher-teach.js keeps
  // openLibFolder outside its render.
  let openStep = null;      // null → autoStep() picks; '' → all closed
  let keepPlace = false;    // true while OUR request decision remounts us
  let listingDraft = null;  // { uid, data } — unsaved cards 1-3 edits
  let contactDraft = null;  // { uid, data } — unsaved card 4 edits
  // V3.786/791 — step 6: the month on screen, and the opportunity being
  // written (null = the form is closed). The draft lives here so a repaint —
  // a calendar tap, a host refresh — never loses what the teacher typed.
  let calMonth = null;      // { y, m }
  let oppForm = null;       // { id, title, acts:Set, fmts:Set, topic, ctx, wanted, dates: Map(iso → {start,end}), last:{start,end} }
  // V3.787 — accepted visits whose confirmation email the teacher has opened
  // but not yet marked as sent (a mailto can't report whether it was sent).
  const composed = new Set();
  // V3.790 — a teacher's edits to a visit's draft email (request id → body),
  // so a repaint never throws them away.
  const emailEdits = new Map();

  const splitList = (v) => String(v || '').split(',').map(s => s.trim()).filter(Boolean);
  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : (many || one + 's'));
  // V3.791 — opportunity helpers, shared with the presenter page via the kit.
  const reqWhen = (r) => r.date || (r.dates || [])[0] || '';
  function oppDates(o) { return (o.dates || []).slice().sort((a, b) => a.date.localeCompare(b.date)); }
  function oppNextDate(o, today) {
    const d = oppDates(o).map(x => x.date).filter(x => x >= (today || todayISO()));
    return d[0] || null;
  }
  function oppLastDate(o) { const d = oppDates(o); return d.length ? d[d.length - 1].date : ''; }
  // "Tue, Oct 6 · Tue, Oct 13 (10:00–10:50)" — the time once if every date
  // shares it, otherwise per date.
  function oppDatesLine(o) {
    const ds = oppDates(o);
    if (!ds.length) return 'no dates yet';
    const times = new Set(ds.map(d => (d.startTime || '') + '–' + (d.endTime || '')));
    if (times.size === 1) return ds.map(d => fmtDay(d.date)).join(' · ') + ' (' + [...times][0] + ')';
    return ds.map(d => `${fmtDay(d.date)} ${d.startTime || ''}–${d.endTime || ''}`).join(' · ');
  }

  // Fixed key order, so two listings compare with JSON.stringify.
  function listingOf(prof, fallbackName) {
    return {
      displayName: String(prof.displayName || fallbackName || '').trim(),
      school: String(prof.school || '').trim(),
      schoolType: prof.schoolType || '',
      city: String(prof.city || '').trim(),
      gradeLevels: prof.gradeLevels || [],
      subjects: prof.subjects || [],
      classSize: prof.classSize != null ? Number(prof.classSize) || null : null,
      topics: prof.topics || [],
      activityTypes: prof.activityTypes || [],
      formats: prof.formats || []
    };
  }
  function contactOf(c) {
    return {
      address: c.address || '', room: c.room || '',
      phone: c.phone || '', arrivalNotes: c.arrivalNotes || ''
    };
  }
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  function stepStates(S) {
    const { L, C, prof, opps, requests } = S;
    const approved = prof.status === 'approved';
    const today = todayISO();
    const pendingReqs = requests.filter(r => r.status === 'pending');
    const upcoming = requests.filter(r => r.status === 'confirmed' && String(r.date || '') >= today);
    const openOpps = opps.filter(o => o.status === 'open' && oppNextDate(o, today));
    const pendingOn = openOpps.reduce((n, o) => n + (o.pendingCount || 0), 0);
    const cls = [
      L.gradeLevels.length ? 'Grades ' + L.gradeLevels.join(', ') : '',
      L.subjects.join(', '),
      L.classSize ? L.classSize + ' students' : ''
    ].filter(Boolean);
    const st = {};
    st.about = L.displayName && L.school
      ? { state: 'done', summary: [L.displayName, L.school, L.schoolType && label(SCHOOL_TYPES, L.schoolType), L.city].filter(Boolean).join(' · ') }
      : { state: 'todo', summary: 'Your name and your school' };
    st.class = cls.length
      ? { state: 'done', summary: cls.join(' · ') }
      : { state: 'todo', summary: 'Grades, subject and class size' };
    st.kinds = L.activityTypes.length && L.formats.length
      ? { state: 'done', summary: L.activityTypes.map(a => label(ACTIVITY_TYPES, a)).join(', ') +
            ' — ' + L.formats.map(f => label(FORMATS, f)).join(' / ') }
      : { state: 'todo', summary: 'Talks, demos, tours or career chats; in person or on video' };
    st.location = C.address
      ? { state: 'done', summary: [C.address, C.room].filter(Boolean).join(' · ') + ' (private)' }
      : L.formats.includes('at-school')
        ? { state: 'todo', summary: 'Needed for visits at your school. Kept private' }
        : { state: 'optional', summary: 'Only needed for visits at your school' };
    st.submit = S.dirty
      ? { state: 'todo', summary: 'You have changes to send' }
      : approved ? { state: 'done', summary: 'Live: researchers can see your class' }
      : prof.status === 'pending' ? { state: 'wait', summary: 'The lab is reviewing it' }
      : { state: 'todo', summary: 'Not sent yet' };
    st.slots = approved
      ? (openOpps.length
          ? { state: 'done', summary: plural(openOpps.length, 'opportunity', 'opportunities') + ' open for sign-up' +
              (pendingOn ? ` · ${plural(pendingOn, 'sign-up')} pending` : '') }
          : { state: 'todo', summary: opps.length ? 'Nothing open for sign-up right now'
              : 'Say what you would like a presenter to do, and the dates that work' })
      : opps.length
        ? { state: 'wait', summary: 'Hidden from presenters until the lab approves your listing' }
        : { state: 'locked', summary: 'Opens once the lab approves your listing' };
    const owed = upcoming.filter(r => !r.emailedAt);
    st.visits = pendingReqs.length
      ? { state: 'action', summary: pendingReqs.length + ' waiting on your answer', count: pendingReqs.length, tag: pendingReqs.length + ' new' }
      : owed.length
        ? { state: 'action', summary: owed.length === 1 ? 'An accepted visit needs your email to the presenter'
              : owed.length + ' accepted visits need your email to the presenter', count: owed.length, tag: 'email owed', owed: true }
      : upcoming.length
        ? { state: 'done', summary: plural(upcoming.length, 'visit') + ' coming up' }
        : { state: 'idle', summary: approved ? 'No requests yet' : 'Requests arrive once your class is listed' };
    return st;
  }

  // The first card that needs the teacher: an unanswered request beats
  // everything, then the first unfinished set-up step.
  function autoStep(st) {
    if (st.visits.state === 'action') return 'visits';
    const first = SETUP_STEPS.find(id => st[id].state === 'todo');
    if (first) return first;
    if (st.submit.state === 'wait') return 'submit';
    if (st.slots.state === 'todo') return 'slots';
    return 'visits';
  }

  // The listing exactly as a researcher browsing the hub sees it. The
  // browse view and step 5's preview both use it, so the preview can't
  // drift from the real thing.
  function listingHeadHTML(t) {
    const grades = (t.gradeLevels || []).join('/');
    return `
      <div class="eh-teacher-head">
        <strong>${esc(t.displayName || 'Teacher')}</strong>
        <span class="tc-muted">${esc([t.school, t.city].filter(Boolean).join(', '))}</span>
        ${t.schoolType ? `<span class="tc-chip tc-chip-draft">${esc(label(SCHOOL_TYPES, t.schoolType))}</span>` : ''}
        <span class="tc-muted">${esc([grades && 'grades ' + grades, (t.subjects || []).join(', '), t.classSize ? t.classSize + ' students' : ''].filter(Boolean).join(' · '))}</span>
      </div>
      ${(t.topics || []).length ? `<p class="tc-muted">Interested in: ${(t.topics || []).map(esc).join(' · ')}</p>` : ''}
      <p class="tc-muted">${(t.activityTypes || []).map(a => esc(label(ACTIVITY_TYPES, a))).join(' · ')}
        ${(t.formats || []).length ? ' — ' + (t.formats || []).map(f => esc(label(FORMATS, f))).join(' / ') : ''}</p>`;
  }

  function ctxLine(cc) {
    return cc ? [cc.subject, cc.grade ? 'gr ' + cc.grade : '', cc.size ? cc.size + ' students' : '']
      .filter(Boolean).join(' · ') : '';
  }

  /* ---- V3.787/790 — the confirmation email a teacher sends after accepting
     a visit. This project has no outbound mail server by design, so the
     teacher sends it from their own account (copy the draft, or open it in
     their mail app). Alex: "This email should include all instructions for
     the presenter" — the visit, where to go (or how to join), before the
     visit, on the day, and the review afterwards. V3.791 names the
     opportunity, and the other presenters when the teacher asked for
     several together.
     V3.808 — moved out of the signed-in teacher panel's closure so the
     no-account guest page (engage-guest.js) sends the IDENTICAL email. Pure:
     `c` = { r, opp, loc, school, teacherName, subject, grade, size, others }.
     Returns null when the request has no email address. ---- */
  function buildVisitEmail(c) {
    const r = c.r || {};
    if (!r.requesterEmail) return null;
    const opp = c.opp || {};
    const loc = c.loc || {};
    const school = c.school || 'our school';
    const dt = new Date(r.date + 'T00:00');
    const longDate = isNaN(dt) ? r.date
      : dt.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    const subject = c.subject || '';
    const grade = c.grade || '';
    const students = r.expectedStudents
      ? String(r.expectedStudents)
      : c.size ? 'about ' + c.size : '';
    const others = c.others || [];
    const teacher = c.teacherName || '';
    const phone = loc.phone || '';
    const time = [r.startTime, r.endTime].filter(Boolean).join('–');
    const cls = [subject, grade && (/[–\-,/ ]/.test(grade) ? 'grades ' : 'grade ') + grade].filter(Boolean).join(', ');
    const L = [];
    const add = (...lines) => L.push(...lines.filter(x => x !== null));

    add(`Hi ${String(r.requesterName || '').trim() || 'there'},`, '',
      `Thank you for offering to visit ${school}. I've accepted your request, and this email has everything you need for the visit.`, '');

    add('THE VISIT',
      opp.title ? `- What I've asked for: ${opp.title}` : null,
      `- Date: ${longDate}`,
      `- Time: ${time}${r.endTime ? ` (please plan to finish by ${r.endTime})` : ''}`,
      `- Your part: ${label(ACTIVITY_TYPES, r.activityType)}${r.topic ? ' — ' + r.topic : ''}`,
      `- Class: ${cls || 'my class'}${students ? `, ${students} students` : ''}`,
      (opp.presentersWanted || 1) > 1
        ? (others.length
            ? `- Presenting alongside you: ${others.map(o => [o.requesterName, o.requesterAffiliation].filter(Boolean).join(' (') + (o.requesterAffiliation ? ')' : '')).join('; ')}. I'll introduce you to each other by email.`
            : `- I'm hoping for up to ${opp.presentersWanted} presenters together; you're the first. I'll introduce everyone by email once the panel is set.`)
        : null,
      '');

    if (r.format === 'virtual') {
      add('HOW TO JOIN',
        "- This is a virtual visit. I'll send you the video link before the day.",
        '- Please join 10 minutes early so we can check your sound and screen sharing with the classroom.',
        phone ? `- If the link doesn't work on the day, call me at ${phone}.` : null,
        '');
    } else if (r.format === 'visit-uofa') {
      add('WHERE WE MEET',
        '- My class will come to you at the University of Arizona.',
        '- Please reply with where we should meet, and anything we need to know: where a bus can drop us off, which entrance to use, and any safety rules for the lab.',
        phone ? `- On the day you can reach me at ${phone}.` : null,
        '');
    } else {
      add('WHERE TO GO',
        `- ${school}${loc.address ? ', ' + loc.address : ''}`,
        loc.room ? `- Room: ${loc.room}` : null,
        loc.arrivalNotes ? `- When you arrive: ${loc.arrivalNotes}` : null,
        phone ? `- If you're running late or can't find us, call ${phone}.` : null,
        '');
    }

    add('BEFORE THE VISIT',
      '- Please reply to this email to confirm you can make it.',
      r.format === 'virtual'
        ? '- Let me know if you plan to share slides or a video, and anything the students should have ready.'
        : r.format === 'visit-uofa'
          ? '- Let me know anything the students should bring, wear or read beforehand (closed-toe shoes for a lab, for example).'
          : '- Let me know what you will need: a projector or screen (and which connector), power outlets, tables, a sink, or anything the students should do beforehand.',
      '- If anything changes, or you can no longer come, reply here as soon as you can so the class can plan around it.',
      '');

    add('ON THE DAY',
      r.format === 'at-school'
        ? '- Please arrive about 15 minutes early and bring a photo ID. Visitors sign in at the front office.'
        : r.format === 'visit-uofa'
          ? `- We'll plan to arrive a few minutes before ${r.startTime || 'the start time'}.`
          : null,
      '- Leave a few minutes at the end for questions. The students always have them.',
      r.format === 'virtual'
        ? "- Please don't record the session or take screenshots of the students."
        : "- Please don't take photos of the students.",
      '');

    add('AFTER THE VISIT',
      '- Please leave a short review of how it went. Go to https://mcgheelab.com/#/presenters, sign in with the same Google account you used to request the visit, and it will be waiting under "Your visits". It takes about two minutes and helps the McGhee Lab keep these visits going.',
      '');

    if (r.teacherNote) add(`A note from me: ${r.teacherNote}`, '');

    add('Thank you!', '', teacher, school, phone || null);

    return {
      to: r.requesterEmail,
      subject: `Your visit to ${school} on ${isNaN(dt) ? r.date : fmtDay(r.date)}`,
      body: L.join('\n').replace(/\n{3,}/g, '\n\n').trim()
    };
  }
  function kitMailtoOf(to, subject, body) {
    return 'mailto:' + encodeURIComponent(to) +
      '?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(body);
  }

  const STATE_TAG = {
    todo: ['tc-chip-draft', 'To do'],
    wait: ['tc-chip-pending', 'Waiting'],
    optional: ['tc-chip-draft', 'Optional'],
    locked: ['tc-chip-draft', 'Later']
  };

  async function renderTeacherHub(root, opts) {
    opts = opts || {};
    // A fresh visit starts at the card that needs you; a remount we caused
    // ourselves (a request decision refreshing the host) stays put.
    if (!keepPlace) openStep = null;
    keepPlace = false;
    const uid = me();
    const p = myProfile();
    let S = null;

    async function reload() {
      const [profile, contact, opps, requests, reviews] = await Promise.all([
        src().getEngageProfile(uid),
        src().getEngageContact(uid).catch(() => null),
        src().myOpportunities(uid),
        src().engageRequestsForTeacher(uid).catch(() => []),
        // by query only — see teacher-classes.js reviewsForTeacher
        (src().reviewsForTeacher ? src().reviewsForTeacher(uid) : Promise.resolve([])).catch(() => [])
      ]);
      S = { profile, prof: profile || {}, contact: contact || {}, opps, requests,
        oppById: new Map(opps.map(o => [o.id, o])),
        reviews: new Map(reviews.map(r => [r.id, r])) };
      paint();
    }

    function paint() {
      const prof = S.prof;
      S.baseline = listingOf(prof, p.name);
      S.contactBase = contactOf(S.contact);
      if (listingDraft && (listingDraft.uid !== uid || same(listingDraft.data, S.baseline))) listingDraft = null;
      if (contactDraft && (contactDraft.uid !== uid || same(contactDraft.data, S.contactBase))) contactDraft = null;
      S.L = listingDraft ? listingDraft.data : S.baseline;
      S.C = contactDraft ? contactDraft.data : S.contactBase;
      // Only a listing that is already with the lab can be "changed but not
      // sent" — a draft saves itself card by card.
      S.autoSaves = prof.status !== 'approved' && prof.status !== 'pending';
      S.dirty = !!listingDraft && !S.autoSaves;
      const st = stepStates(S);
      if (openStep == null) openStep = autoStep(st);

      const setupDone = SETUP_STEPS.filter(id => st[id].state === 'done' || st[id].state === 'optional').length;
      const card = (s, i) => stepHTML(s, i + 1, st[s.id]);

      root.innerHTML = `
        ${opts.embedded ? '' : `
        <div class="dash-header">
          <h2>Engagement Hub — my classroom</h2>
          <a class="btn btn-secondary" href="#/teach">&larr; Teaching dashboard</a>
        </div>`}
        <div class="eh-teacher">
          <div id="eh-status" class="teach-status" hidden></div>
          ${st.visits.state === 'action' && openStep !== 'visits' ? `
          <div class="eh-callout">
            <span>${st.visits.owed
              ? (st.visits.count === 1 ? 'A visit you accepted still needs' : st.visits.count + ' visits you accepted still need') + ' your email to the presenter.'
              : (st.visits.count === 1 ? 'A visit request is' : st.visits.count + ' visit requests are') + ' waiting on your answer.'}</span>
            <button type="button" class="btn btn-primary btn-small" data-goto="visits">${st.visits.owed ? 'Send it' : 'Review ' + (st.visits.count === 1 ? 'it' : 'them')} &rarr;</button>
          </div>` : ''}
          <div class="eh-group">
            <div class="eh-group-head">
              <h4>List your class <span class="tc-muted">— once</span></h4>
              <span class="eh-progress">
                <span class="eh-progress-bar"><span style="width:${setupDone * 20}%"></span></span>
                ${setupDone} of 5 done</span>
            </div>
            ${STEPS.slice(0, 5).map(card).join('')}
          </div>
          <div class="eh-group">
            <div class="eh-group-head"><h4>Run your visits</h4></div>
            ${STEPS.slice(5).map((s, i) => card(s, i + 5)).join('')}
          </div>
        </div>`;
      wire();
    }

    function stepHTML(step, n, s) {
      const open = openStep === step.id;
      const tag = s.state === 'action'
        ? `<span class="tc-chip tc-chip-pending">${esc(s.tag || s.count + ' new')}</span>`
        : STATE_TAG[s.state] ? `<span class="tc-chip ${STATE_TAG[s.state][0]}">${STATE_TAG[s.state][1]}</span>` : '';
      return `
        <section class="eh-step${open ? ' open' : ''} is-${s.state}" data-step="${step.id}">
          <button type="button" class="eh-step-head" data-step-toggle
            aria-expanded="${open ? 'true' : 'false'}" aria-controls="eh-step-body-${step.id}">
            <span class="eh-step-n" aria-hidden="true">${s.state === 'done' ? '&#10003;' : n}</span>
            <span class="eh-step-titles">
              <span class="eh-step-title"><span class="eh-sr">Step ${n}: </span>${esc(step.title)}</span>
              <span class="eh-step-sum">${esc(s.summary)}</span>
            </span>
            ${tag}
            <span class="eh-step-caret" aria-hidden="true">${open ? '&#9662;' : '&#9656;'}</span>
          </button>
          <div class="eh-step-body" id="eh-step-body-${step.id}"${open ? '' : ' hidden'}>
            <div class="teach-status" data-step-status hidden></div>
            ${BODIES[step.id](s)}
          </div>
        </section>`;
    }

    const nav = (back, next, nextLabel) => `
      <div class="eh-step-nav">
        ${back ? `<button type="button" class="btn btn-secondary btn-small" data-goto="${back}">&larr; Back</button>` : ''}
        ${next ? `<button type="button" class="btn btn-primary btn-small eh-next" data-step-next>${nextLabel || 'Save &amp; continue &rarr;'}</button>` : ''}
      </div>`;
    // Cards 1-3 only write while the listing is still a draft.
    const listingNextLabel = () => S.autoSaves ? 'Save &amp; continue &rarr;' : 'Next &rarr;';

    // The class context a new time is stamped with: the teacher's own step-2
    // answers first; the host's hint only fills a gap (its size is the
    // ONLINE roster, often not the room).
    function slotCtxDefaults() {
      return {
        subject: (S.prof.subjects || [])[0] || opts.classHint?.subject || '',
        grade: (S.prof.gradeLevels || []).join('–'),
        size: S.prof.classSize || opts.classHint?.size || ''
      };
    }

    /* ---- V3.787/790 — the confirmation email a teacher sends after
       accepting. This project has no outbound mail server by design, so the
       teacher sends it from their own account: V3.790 shows it as a draft to
       COPY (To / Subject / an editable body), because a mailto: does nothing
       for someone who reads mail in a browser tab, and "Open in your email
       app" stays as the second option. Alex: "This email should include all
       instructions for the presenter" — the visit, where to go (or how to
       join), before the visit, on the day, and the review afterwards. Built
       from the request, its opportunity and the teacher's private location.
       V3.791 — names the opportunity, and the other presenters when the
       teacher asked for several together. ---- */
    // V3.808 — the text itself is the module-level buildVisitEmail (shared via
    // the kit with the no-account guest page, engage-guest.js); this only
    // gathers what the signed-in teacher panel knows.
    function visitEmailParts(r) {
      const opp = S.oppById.get(r.opportunityId) || {};
      const cc = opp.classContext || {};
      return buildVisitEmail({
        r, opp,
        loc: r.location || S.contact || {},
        school: S.prof.school || 'our school',
        teacherName: S.prof.displayName || p.name || '',
        subject: cc.subject || (S.prof.subjects || [])[0] || '',
        grade: cc.grade || (S.prof.gradeLevels || []).join('–'),
        size: cc.size || S.prof.classSize,
        others: (opp.acceptedRequestIds || []).filter(id => id !== r.id)
          .map(id => S.requests.find(x => x.id === id)).filter(x => x && x.status === 'confirmed')
      });
    }
    function mailtoOf(to, subject, body) { return kitMailtoOf(to, subject, body); }

    // The copy-and-send block for one accepted visit. `withSentButton` is
    // false once the teacher has already marked it sent (the block is then
    // only a way to see or resend the email).
    function emailBlockHTML(r, parts, withSentButton) {
      const body = emailEdits.has(r.id) ? emailEdits.get(r.id) : parts.body;
      const edited = emailEdits.has(r.id) && emailEdits.get(r.id) !== parts.body;
      return `
        <div class="eh-email" data-email="${esc(r.id)}">
          <div class="eh-email-row"><span class="eh-email-label">To</span>
            <span class="eh-email-val">${esc(parts.to)}</span>
            <button type="button" class="btn btn-secondary btn-small" data-copy="to">Copy</button></div>
          <div class="eh-email-row"><span class="eh-email-label">Subject</span>
            <span class="eh-email-val">${esc(parts.subject)}</span>
            <button type="button" class="btn btn-secondary btn-small" data-copy="subject">Copy</button></div>
          <label class="eh-sr" for="eh-email-body-${esc(r.id)}">Email to ${esc(r.requesterName || 'the presenter')}</label>
          <textarea id="eh-email-body-${esc(r.id)}" class="eh-email-body" rows="16" data-email-body spellcheck="true">${esc(body)}</textarea>
          <div class="eh-email-actions">
            <button type="button" class="btn btn-primary btn-small" data-copy="body">Copy the email</button>
            <button type="button" class="btn btn-secondary btn-small" data-compose="${esc(r.id)}"
              data-href="${esc(mailtoOf(parts.to, parts.subject, body))}">Open in your email app</button>
            <button type="button" class="btn btn-secondary btn-small" data-reset-email${edited ? '' : ' hidden'}>Undo my edits</button>
            <span class="eh-email-copied" aria-live="polite"></span>
          </div>
          ${withSentButton ? `
          <p class="eh-mail-step eh-mail-sent"><span>Once it's sent, mark it here so this visit stops asking.</span>
            <button type="button" class="btn ${composed.has(r.id) ? 'btn-primary' : 'btn-secondary'} btn-small" data-mark-emailed>Yes, I sent it</button></p>` : ''}
        </div>`;
    }
    /* ---- step 6 (V3.791) — opportunities. One thing the teacher would like
       (a guest talk on X for AP Physics) with SEVERAL dates that would work.
       Presenters sign up for the opportunity and tick the dates they could do;
       the teacher accepts one (or several, for a panel) and picks the date,
       and the opportunity leaves the sign-up list. The calendar shows every
       opportunity's dates and doubles as the date picker for the form. ---- */
    function newOppDraft(firstDate) {
      const cx = slotCtxDefaults();
      const acts = new Set(S.prof.activityTypes || []);
      const fmts = new Set(S.prof.formats || []);
      const d = { id: null, title: '', acts, fmts, topic: '', ctx: cx, wanted: 1,
        dates: new Map(), last: { start: '10:00', end: '10:50' }, status: 'open' };
      if (firstDate) d.dates.set(firstDate, { ...d.last });
      return d;
    }
    function draftFromOpp(o) {
      const ds = oppDates(o);
      const d = { id: o.id, title: o.title || '', acts: new Set(o.activityTypes || []), fmts: new Set(o.formats || []),
        topic: o.topic || '', ctx: { ...slotCtxDefaults(), ...(o.classContext || {}) },
        wanted: o.presentersWanted || 1, dates: new Map(ds.map(x => [x.date, { start: x.startTime || '', end: x.endTime || '' }])),
        last: { start: ds[0]?.startTime || '10:00', end: ds[0]?.endTime || '10:50' }, status: o.status || 'open' };
      return d;
    }
    // Short enough for a calendar chip: "10:00 Guest talk: how…" → "10:00 Guest talk".
    const chipTitle = (o) => String(o.title || label(ACTIVITY_TYPES, (o.activityTypes || [])[0]) || 'opportunity')
      .split(/[:—\-–,(]/)[0].trim().slice(0, 18);

    function calendarBlockHTML(approved) {
      const today = todayISO();
      const now = new Date();
      if (!calMonth) {
        // Open on the month of the next upcoming date, else this month.
        const next = S.opps.map(o => oppNextDate(o, today)).filter(Boolean).sort()[0];
        const d = next ? fromISO(next) : now;
        calMonth = { y: d.getFullYear(), m: d.getMonth() };
      }
      const first = isoLocal(new Date(calMonth.y, calMonth.m, 1));
      const last = isoLocal(new Date(calMonth.y, calMonth.m + 1, 0));
      const days = {};
      const RANK = { open: 1, pending: 2, busy: 3 };
      const put = (iso, chip, tone) => {
        const d = days[iso] = days[iso] || { chips: [] };
        d.chips.push(chip);
        if ((RANK[tone] || 0) > (RANK[d.tone] || 0)) d.tone = tone;
      };
      for (const o of S.opps) {
        if (o.status === 'closed') continue;
        for (const d of oppDates(o)) {
          if (d.date < first || d.date > last) continue;
          const booked = o.status === 'booked' || (o.bookedDate && o.bookedDate === d.date);
          const text = (d.startTime || '') + ' ' + chipTitle(o);
          if (booked && o.bookedDate === d.date) put(d.date, { text, tone: 'booked' }, 'busy');
          else if (o.status === 'booked' || o.status === 'paused') put(d.date, { text, tone: 'paused' });
          else if (o.pendingCount) put(d.date, { text, tone: 'pending' }, 'pending');
          else put(d.date, { text, tone: 'open' }, 'open');
        }
      }
      for (const d of Object.values(days)) d.label = d.chips.map(c => c.text).join(', ');
      const mk = (y, m) => y * 12 + m;
      const here = mk(calMonth.y, calMonth.m), nowK = mk(now.getFullYear(), now.getMonth());
      return `
        <div class="eh-sublist eh-teacher-cal">
          <h5>Calendar <span class="tc-muted">— ${oppForm
            ? 'tap the days that would work for this opportunity'
            : approved ? 'tap a day to start an opportunity on it' : 'your opportunities’ dates'}</span></h5>
          ${monthGridHTML({
            year: calMonth.y, month: calMonth.m, days, selected: oppForm ? new Set(oppForm.dates.keys()) : new Set(),
            canPrev: here > nowK, canNext: here < nowK + 12,
            legend: [['open', 'Open for sign-up'], ['pending', 'Sign-up pending'], ['booked', 'Booked'], ['paused', 'Paused / filled']]
          })}
        </div>`;
    }

    function oppFormHTML() {
      const f = oppForm;
      const acts = (S.prof.activityTypes || []).length ? ACTIVITY_TYPES.filter(a => S.prof.activityTypes.includes(a[0])) : ACTIVITY_TYPES;
      const fmts = (S.prof.formats || []).length ? FORMATS.filter(x => S.prof.formats.includes(x[0])) : FORMATS;
      const dates = [...f.dates.keys()].sort();
      return `
        <form id="eh-opp-form" class="eh-opp-form" novalidate>
          <h5>${f.id ? 'Edit opportunity' : 'New opportunity'}</h5>
          <div class="form-group"><label for="eh-of-title">What would you like? <span class="tc-muted">(the title presenters see)</span></label>
            <input id="eh-of-title" type="text" data-of="title" value="${esc(f.title)}"
              placeholder="e.g. Guest talk on materials for AP Physics"></div>
          <fieldset class="eh-choices eh-choices-inline">
            <legend>Kind of visit</legend>
            ${acts.map(([k, l]) => `<label class="eh-choice"><input type="checkbox" data-of-act value="${k}"${f.acts.has(k) ? ' checked' : ''}> <span><strong>${esc(l)}</strong></span></label>`).join('')}
          </fieldset>
          <fieldset class="eh-choices eh-choices-inline">
            <legend>Where</legend>
            ${fmts.map(([k, l]) => `<label class="eh-choice"><input type="checkbox" data-of-fmt value="${k}"${f.fmts.has(k) ? ' checked' : ''}> <span><strong>${esc(l)}</strong></span></label>`).join('')}
          </fieldset>
          <div class="form-group"><label for="eh-of-topic">Topic or details <span class="tc-muted">(optional)</span></label>
            <input id="eh-of-topic" type="text" data-of="topic" value="${esc(f.topic)}" placeholder="e.g. anything hands-on about materials; 40 minutes plus questions"></div>
          <div class="eh-fields">
            <div class="form-group"><label for="eh-of-subject">Class</label>
              <input id="eh-of-subject" type="text" data-of="subject" value="${esc(f.ctx.subject || '')}" placeholder="e.g. AP Physics"></div>
            <div class="form-group"><label for="eh-of-grade">Student level</label>
              <input id="eh-of-grade" type="text" data-of="grade" value="${esc(f.ctx.grade || '')}" placeholder="e.g. 11–12"></div>
            <div class="form-group"><label for="eh-of-size">Students</label>
              <input id="eh-of-size" type="number" min="1" max="500" data-of="size" value="${esc(String(f.ctx.size || ''))}"></div>
          </div>
          <fieldset class="eh-choices eh-choices-inline eh-wanted">
            <legend>How many presenters?</legend>
            <label class="eh-choice"><input type="radio" name="eh-of-wanted" data-of-wanted value="1"${f.wanted <= 1 ? ' checked' : ''}> <span><strong>One presenter</strong></span></label>
            <label class="eh-choice"><input type="radio" name="eh-of-wanted" data-of-wanted value="many"${f.wanted > 1 ? ' checked' : ''}>
              <span><strong>Several together</strong><span class="tc-muted">a panel or a careers day — up to
                <input type="number" min="2" max="8" data-of="wantedN" value="${f.wanted > 1 ? f.wanted : 3}" aria-label="How many presenters"> presenters</span></span></label>
          </fieldset>
          <h5>Dates that would work</h5>
          <p class="tc-muted">Tap days on the calendar above. Give the first one a time and the rest follow it; change any that differ.</p>
          ${dates.length ? `<div class="eh-opp-datelist">
            ${dates.map(iso => { const t = f.dates.get(iso); return `
              <div class="eh-opp-daterow" data-date="${iso}">
                <strong>${esc(fmtDay(iso))}</strong>
                <label>From <input type="time" data-of-start value="${esc(t.start)}"></label>
                <label>To <input type="time" data-of-end value="${esc(t.end)}"></label>
                <button type="button" class="btn btn-secondary btn-small" data-of-remove aria-label="Remove ${esc(fmtDay(iso))}">&#10005;</button>
              </div>`; }).join('')}
          </div>` : '<p class="error-text eh-opp-nodates">No dates yet. Tap at least one day on the calendar.</p>'}
          <div class="eh-step-nav">
            <button type="button" class="btn btn-secondary btn-small" data-of-cancel>Cancel</button>
            <button type="submit" class="btn btn-primary btn-small eh-next">${f.id ? 'Save changes' : 'Post this opportunity'}</button>
          </div>
        </form>`;
    }

    function oppCardHTML(o, today) {
      const st = OPP_STATUS[o.status] || OPP_STATUS.open;
      const ds = oppDates(o);
      const wanted = o.presentersWanted || 1;
      const accepted = o.acceptedCount || (o.acceptedRequestIds || []).length || 0;
      const acceptedReqs = (o.acceptedRequestIds || []).map(id => S.requests.find(r => r.id === id)).filter(r => r && r.status === 'confirmed');
      const past = !oppNextDate(o, today);
      const flags = [];
      if (o.pendingCount) flags.push(`<button type="button" class="eh-flag eh-flag-pending" data-goto="visits">${plural(o.pendingCount, 'sign-up')} waiting on you &rarr;</button>`);
      if (wanted > 1 && accepted && o.status === 'open') flags.push(`<span class="eh-flag eh-flag-open">${accepted} of ${wanted} presenters accepted · still open for more</span>`);
      if (acceptedReqs.length) flags.push(`<span class="eh-flag eh-flag-booked">${o.status === 'booked' ? 'Booked' : 'Accepted'}: ${acceptedReqs.map(r => esc(r.requesterName || '')).join(', ')}${o.bookedDate ? ' on ' + esc(fmtDay(o.bookedDate)) : ''}</span>`);
      return `
        <div class="eh-opp is-${esc(o.status || 'open')}${past ? ' is-past' : ''}" data-opp="${esc(o.id)}">
          <div class="eh-opp-head">
            <strong>${esc(o.title || 'Opportunity')}</strong>
            <span class="tc-chip ${st[0]}">${past && o.status !== 'booked' ? 'dates passed' : st[1]}</span>
            ${wanted > 1 ? `<span class="tc-chip tc-chip-draft">up to ${wanted} presenters</span>` : ''}
          </div>
          <span class="tc-muted">${(o.activityTypes || []).map(a => esc(label(ACTIVITY_TYPES, a))).join(' · ')}${(o.formats || []).length ? ' — ' + o.formats.map(x => esc(label(FORMATS, x))).join(' / ') : ''}${o.topic ? ' · ' + esc(o.topic) : ''}</span>
          ${ctxLine(o.classContext) ? `<span class="tc-muted">${esc(ctxLine(o.classContext))}</span>` : ''}
          <div class="eh-opp-dates">
            ${ds.map(d => `<span class="eh-opening${o.bookedDate === d.date ? ' is-booked' : ''}${d.date < today ? ' is-past' : ''}">${esc(fmtDay(d.date))} · ${esc(d.startTime || '')}–${esc(d.endTime || '')}</span>`).join('')}
          </div>
          ${flags.length ? `<div class="eh-opp-flags">${flags.join('')}</div>` : ''}
          <div class="teach-assign-actions">
            ${!past && o.status !== 'booked' ? `<button type="button" class="btn btn-secondary btn-small" data-opp-edit>Edit</button>` : ''}
            ${!past && (o.status === 'open' || o.status === 'paused') ? `<button type="button" class="btn btn-secondary btn-small" data-opp-toggle>${o.status === 'paused' ? 'Resume' : 'Pause'}</button>` : ''}
            ${!past && o.status === 'open' && wanted > 1 && accepted ? `<button type="button" class="btn btn-secondary btn-small" data-opp-close>That's enough presenters</button>` : ''}
            ${!past && (o.status === 'booked' || o.status === 'closed') && !acceptedReqs.length ? `<button type="button" class="btn btn-secondary btn-small" data-opp-reopen>Reopen</button>` : ''}
            ${!acceptedReqs.length || past ? `<button type="button" class="btn btn-secondary btn-small" data-opp-delete>Delete</button>` : ''}
          </div>
        </div>`;
    }

    const BODIES = {
      about: () => `
        <p class="eh-step-lead">Researchers see this when they look for a classroom to visit.</p>
        <div class="eh-fields">
          <div class="form-group"><label for="eh-ep-name">Your name</label>
            <input id="eh-ep-name" type="text" data-ep-name value="${esc(S.L.displayName)}" autocomplete="name"></div>
          <div class="form-group"><label for="eh-ep-school">School</label>
            <input id="eh-ep-school" type="text" data-ep-school value="${esc(S.L.school)}"></div>
          <div class="form-group"><label for="eh-ep-city">City</label>
            <input id="eh-ep-city" type="text" data-ep-city value="${esc(S.L.city)}" placeholder="e.g. Tucson"></div>
        </div>
        <fieldset class="eh-choices eh-choices-inline">
          <legend>Kind of school</legend>
          ${SCHOOL_TYPES.map(([k, l]) => `
            <label class="eh-choice"><input type="radio" name="eh-ep-type" data-ep-type value="${k}"${S.L.schoolType === k ? ' checked' : ''}>
              <span><strong>${esc(l)}</strong></span></label>`).join('')}
        </fieldset>
        ${nav(null, true, listingNextLabel())}`,

      class: () => `
        <p class="eh-step-lead">A rough picture is enough. It helps a researcher pitch the visit at the right level.</p>
        <div class="eh-fields">
          <div class="form-group"><label for="eh-ep-grades">Grades</label>
            <input id="eh-ep-grades" type="text" data-ep-grades value="${esc(S.L.gradeLevels.join(', '))}" placeholder="e.g. 11, 12"></div>
          <div class="form-group"><label for="eh-ep-subjects">Subject</label>
            <input id="eh-ep-subjects" type="text" data-ep-subjects value="${esc(S.L.subjects.join(', '))}" placeholder="e.g. AP Physics"></div>
          <div class="form-group"><label for="eh-ep-size">Students in the class</label>
            <input id="eh-ep-size" type="number" data-ep-size min="1" max="500" value="${S.L.classSize != null ? esc(String(S.L.classSize)) : ''}"></div>
        </div>
        ${nav('about', true, listingNextLabel())}`,

      kinds: () => `
        <p class="eh-step-lead">Tick everything you'd welcome. Researchers only see the options you pick.</p>
        <fieldset class="eh-choices">
          <legend>What kind of visit?</legend>
          ${ACTIVITY_TYPES.map(([k, l]) => `
            <label class="eh-choice"><input type="checkbox" data-ep-activity value="${k}"${S.L.activityTypes.includes(k) ? ' checked' : ''}>
              <span><strong>${esc(l)}</strong><span class="tc-muted">${esc(ACTIVITY_HINTS[k] || '')}</span></span></label>`).join('')}
        </fieldset>
        <fieldset class="eh-choices">
          <legend>Where?</legend>
          ${FORMATS.map(([k, l]) => `
            <label class="eh-choice"><input type="checkbox" data-ep-format value="${k}"${S.L.formats.includes(k) ? ' checked' : ''}>
              <span><strong>${esc(l)}</strong><span class="tc-muted">${esc(FORMAT_HINTS[k] || '')}</span></span></label>`).join('')}
        </fieldset>
        <div class="form-group"><label for="eh-ep-topics">Topics your class would like to hear about <span class="tc-muted">(optional, separate with commas)</span></label>
          <input id="eh-ep-topics" type="text" data-ep-topics value="${esc(S.L.topics.join(', '))}" placeholder="e.g. bioprinting, careers in engineering, how research works"></div>
        ${nav('class', true, listingNextLabel())}`,

      location: () => `
        <p class="eh-step-lead"><strong>Kept private.</strong> Only the lab, and a researcher whose visit you
          confirm, ever see this. It is never shown on the hub.
          ${S.L.formats.includes('at-school') ? '' : ` You haven't picked <em>${esc(label(FORMATS, 'at-school'))}</em>, so you can skip this step.`}</p>
        <div class="eh-fields">
          <div class="form-group eh-wide"><label for="eh-ec-address">School street address</label>
            <input id="eh-ec-address" type="text" data-ec-address value="${esc(S.C.address)}" autocomplete="street-address"></div>
          <div class="form-group"><label for="eh-ec-room">Room</label>
            <input id="eh-ec-room" type="text" data-ec-room value="${esc(S.C.room)}" placeholder="e.g. Building C, Room 214"></div>
          <div class="form-group"><label for="eh-ec-phone">Phone for the day</label>
            <input id="eh-ec-phone" type="tel" data-ec-phone value="${esc(S.C.phone)}"></div>
          <div class="form-group eh-wide"><label for="eh-ec-notes">Arrival notes</label>
            <input id="eh-ec-notes" type="text" data-ec-notes value="${esc(S.C.arrivalNotes)}" placeholder="Parking, check in at the front office…"></div>
        </div>
        ${nav('kinds', true)}`,

      submit: (s) => {
        const status = S.prof.status;
        const missing = [
          !(S.L.displayName && S.L.school) && ['about', 'your name and school'],
          !(S.L.activityTypes.length && S.L.formats.length) && ['kinds', 'the kinds of visit you want']
        ].filter(Boolean);
        let words, actions;
        if (S.dirty) {
          words = status === 'approved'
            ? `<p>You've changed your listing. Sending the changes puts it back with the lab for a quick
                 re-review, and <strong>your class is hidden from researchers until they approve it</strong>.
                 Visits you've already confirmed are not affected.</p>`
            : '<p>You\'ve changed your listing since you sent it. Send the new version for review.</p>';
          actions = `<button type="button" class="btn btn-secondary btn-small" data-discard>Discard changes</button>
                     <button type="button" class="btn btn-primary btn-small eh-next" data-submit>Send changes for review</button>`;
        } else if (status === 'approved') {
          words = '<p><span class="tc-chip tc-chip-approved">live</span> Your class is on the hub. Researchers can see it and request your open times.</p>';
          actions = '<button type="button" class="btn btn-primary btn-small eh-next" data-goto="slots">Next: when your class is free &rarr;</button>';
        } else if (status === 'pending') {
          words = `<p><span class="tc-chip tc-chip-pending">with the lab</span> Sent. The lab reviews every
                     listing before it goes on the hub. Once it's approved, step 6 opens so you can post
                     the times a researcher could come.</p>`;
          actions = '';
        } else {
          words = `<p>Nothing is public yet. The lab reviews every listing before it goes on the hub, and
                     you'll post your free times once it's approved.</p>`;
          actions = '<button type="button" class="btn btn-primary btn-small eh-next" data-submit>Send for review</button>';
        }
        return `
          <p class="eh-step-lead">This is what a researcher browsing the hub will see:</p>
          <div class="eh-teacher-card eh-preview">${listingHeadHTML(S.L)}</div>
          ${missing.length ? `<ul class="eh-missing">${missing.map(([id, what]) => `
            <li>Still to add: ${esc(what)} <button type="button" class="btn btn-secondary btn-small" data-goto="${id}">Add it</button></li>`).join('')}</ul>` : ''}
          ${words}
          <div class="eh-step-nav">
            <button type="button" class="btn btn-secondary btn-small" data-goto="location">&larr; Back</button>
            ${actions}
          </div>`;
      },

      slots: (s) => {
        const approved = S.prof.status === 'approved';
        if (s.state === 'locked') return `
          <p class="eh-step-lead">Once the lab approves your listing, this is where you post opportunities:
            what you'd like a presenter to do, and the dates that would work. Presenters sign up for one,
            you accept, and it comes off their list.</p>
          <div class="eh-step-nav">
            <button type="button" class="btn btn-secondary btn-small" data-goto="submit">&larr; Back to step 5</button>
          </div>`;
        const today = todayISO();
        const live = S.opps.filter(o => oppNextDate(o, today) && o.status !== 'closed')
          .sort((a, b) => (oppNextDate(a, today) || '').localeCompare(oppNextDate(b, today) || ''));
        const done = S.opps.filter(o => !live.includes(o))
          .sort((a, b) => oppLastDate(b).localeCompare(oppLastDate(a)));
        return `
          <p class="eh-step-lead">An opportunity is one thing you'd like — a guest talk, a demo, a careers panel —
            with the dates that would work for it. Presenters sign up and tick the dates they could do; you accept one
            (or several, for a panel) and pick the date, and it comes off their list.</p>
          ${approved ? '' : S.prof.status === 'pending'
            ? `<p class="eh-step-lead tc-muted">Your listing is with the lab, so these are hidden from presenters for now.</p>`
            : `<p class="eh-step-lead tc-muted">Your listing isn't on the hub right now, so these are hidden from presenters.
                Send it for review in step 5 to bring them back.</p>`}
          ${calendarBlockHTML(approved)}
          ${oppForm ? oppFormHTML() : approved ? `
            <p><button type="button" class="btn btn-primary btn-small" data-opp-new>+ New opportunity</button></p>` : ''}
          ${live.length ? `<div class="eh-sublist"><h5>Open and upcoming</h5>${live.map(o => oppCardHTML(o, today)).join('')}</div>`
            : !oppForm ? '<p class="tc-muted">No opportunities yet. Tap a day on the calendar, or + New opportunity.</p>' : ''}
          ${done.length ? `<details class="eh-sublist eh-past"><summary>Past and closed (${done.length})</summary>
            ${done.slice(0, 20).map(o => oppCardHTML(o, today)).join('')}</details>` : ''}
          ${nav('submit', true, 'Next: sign-ups &rarr;')}`;
      },

      visits: () => {
        const today = todayISO();
        const reqs = S.requests;
        const pending = reqs.filter(r => r.status === 'pending')
          .sort((a, b) => reqWhen(a).localeCompare(reqWhen(b)));
        const upcoming = reqs.filter(r => r.status === 'confirmed' && String(r.date || '') >= today)
          .sort((a, b) => String(a.date).localeCompare(String(b.date)));
        const past = reqs.filter(r => r.status !== 'pending' && !upcoming.includes(r))
          .sort((a, b) => String(b.date).localeCompare(String(a.date)));
        const what = (r) => `${esc(label(ACTIVITY_TYPES, r.activityType))} · ${esc(label(FORMATS, r.format))}${r.topic ? ' · ' + esc(r.topic) : ''}`;
        const who = (r) => `<strong>${esc(r.requesterName || 'Someone')}</strong>
          <span class="tc-muted">${esc([r.requesterTitle, r.requesterAffiliation].filter(Boolean).join(', '))}</span>`;
        const oppOf = (r) => S.oppById.get(r.opportunityId) || null;
        const oppSize = (r) => oppOf(r)?.classContext?.size || S.prof.classSize || '';
        // The dates a request can be accepted on: the presenter's picks that
        // are still on the opportunity — or only the date already set, when
        // another presenter was accepted first (a panel).
        const acceptable = (r) => {
          const o = oppOf(r);
          const picks = (r.dates || []).filter(d => !o || (o.dateKeys || oppDates(o).map(x => x.date)).includes(d));
          const dates = o?.bookedDate ? picks.filter(d => d === o.bookedDate) : picks;
          return dates.map(d => ({ date: d, ...(oppDates(o || {}).find(x => x.date === d) || { startTime: r.startTime, endTime: r.endTime }) }));
        };
        const reviewLine = (rv) => rv ? `
          <div class="eh-review">
            <span><strong>Their review:</strong> ${esc(String(rv.rating))}/5 overall · students ${esc(String(rv.engagement))}/5 engaged${rv.studentsReached ? ' · ' + esc(String(rv.studentsReached)) + ' students' : ''} · would return: ${esc(rv.wouldReturn || '?')}</span>
            ${rv.wentWell ? `<span class="tc-muted">Went well: ${esc(rv.wentWell)}</span>` : ''}
            ${rv.improve ? `<span class="tc-muted">Next time: ${esc(rv.improve)}</span>` : ''}
          </div>` : '';
        return `
          ${!reqs.length ? `<p class="eh-step-lead">No sign-ups yet. When a presenter signs up for one of your
            opportunities, it lands here and you accept or decline it.</p>` : ''}
          ${pending.length ? `
          <div class="eh-sublist"><h5>Waiting on you</h5>
            ${pending.map(r => {
              const o = oppOf(r);
              const opts_ = acceptable(r);
              const gone = !o || o.status === 'closed' || (o.status === 'booked' && (o.presentersWanted || 1) <= (o.acceptedRequestIds || []).length);
              const others = reqs.filter(x => x.id !== r.id && x.opportunityId === r.opportunityId && x.status === 'pending').length;
              return `
              <div class="eh-req-row" data-req="${esc(r.id)}">
                ${who(r)}
                — wants <strong>${esc(o?.title || r.opportunityTitle || 'an opportunity')}</strong>
                <span class="tc-muted eh-req-what">${what(r)}${r.okWithOthers ? ' · happy to share the session' : ''}</span>
                <span class="eh-req-dates">Could do: ${(r.dates || []).length
                  ? r.dates.slice().sort().map(d => `<span class="eh-opening${o?.bookedDate === d ? ' is-booked' : ''}">${esc(fmtDay(d))}</span>`).join('')
                  : '<span class="tc-muted">no dates given</span>'}</span>
                ${gone ? '<span class="tc-chip tc-chip-denied">this opportunity is already filled</span>' : ''}
                ${!gone && o?.bookedDate && !opts_.length ? `<span class="tc-chip tc-chip-denied">the date is set to ${esc(fmtDay(o.bookedDate))}, which they can't do</span>` : ''}
                ${others ? `<span class="tc-chip tc-chip-pending">${others} other sign-up${others === 1 ? '' : 's'} for this opportunity</span>` : ''}
                ${r.requesterBio ? `<p class="tc-muted">About them: ${esc(r.requesterBio)}</p>` : ''}
                ${r.message ? `<p class="tc-muted">"${esc(r.message)}"</p>` : ''}
                <div class="teach-assign-actions">
                  ${!gone && opts_.length ? '<button type="button" class="btn btn-primary btn-small" data-req-confirm>Accept…</button>' : ''}
                  <button type="button" class="btn btn-secondary btn-small" data-req-decline>Decline…</button>
                </div>
                <form class="eh-decide-form" hidden>
                  <div class="eh-decide-preview" data-preview></div>
                  <fieldset class="eh-choices eh-choices-inline" data-accept-only>
                    <legend>Which date?</legend>
                    ${opts_.map((d, i) => `<label class="eh-choice"><input type="radio" name="eh-pick-${esc(r.id)}" data-decide-date value="${esc(d.date)}"${opts_.length === 1 || i === 0 ? ' checked' : ''}>
                      <span><strong>${esc(fmtDay(d.date))}</strong><span class="tc-muted">${esc(d.startTime || '')}–${esc(d.endTime || '')}</span></span></label>`).join('')}
                  </fieldset>
                  <div class="form-group" data-accept-only><label>How many students should they expect?</label>
                    <input type="number" min="1" max="500" data-decide-students value="${esc(String(oppSize(r)))}"></div>
                  <div class="form-group"><label>Note to the presenter (optional)</label>
                    <input type="text" data-decide-note placeholder="e.g. park in the visitor lot, ask for me at the front office"></div>
                  <p><button type="submit" class="btn btn-primary btn-small" data-decide-go></button></p>
                </form>
              </div>`;
            }).join('')}
          </div>` : ''}
          ${upcoming.length ? `
          <div class="eh-sublist"><h5>Coming up</h5>
            ${upcoming.map(r => {
              const parts = visitEmailParts(r);
              return `
              <div class="eh-req-row${!r.emailedAt ? ' eh-owed' : ''}" data-req="${esc(r.id)}">
                <strong>${esc(fmtDay(r.date))}</strong> ${esc(r.startTime || '')}–${esc(r.endTime || '')}
                — ${who(r)}
                <span class="tc-muted eh-req-what">${esc(oppOf(r)?.title || r.opportunityTitle || '')}${oppOf(r)?.title || r.opportunityTitle ? ' · ' : ''}${what(r)}${r.expectedStudents ? ' · ' + esc(String(r.expectedStudents)) + ' students' : ''}</span>
                ${(() => { const o = oppOf(r); const co = (o?.acceptedRequestIds || []).filter(id => id !== r.id).map(id => reqs.find(x => x.id === id)).filter(x => x && x.status === 'confirmed');
                  return co.length ? `<span class="tc-muted">Presenting alongside: ${co.map(x => esc(x.requesterName || '')).join(', ')}</span>` : ''; })()}
                ${!parts
                  ? `<p class="error-text">There's no email address on this request. Contact the McGhee Lab and we'll pass the details on.</p>`
                  : r.emailedAt
                    ? `<p><span class="tc-chip tc-chip-approved">email sent ✓</span></p>
                       <details class="eh-email-again"><summary>Show the email again</summary>${emailBlockHTML(r, parts, false)}</details>`
                    : `<p class="eh-mail-step"><span class="tc-chip tc-chip-pending">email not sent yet</span>
                         <span>Your email to ${esc(r.requesterName || 'the presenter')} is ready. Copy it into a new email
                           from your own account and send it. It has everything they need: when, where, how many
                           students, what to bring and how to check in.</span></p>
                       ${emailBlockHTML(r, parts, true)}`}
                <p><button type="button" class="btn btn-secondary btn-small" data-cancel-visit>Cancel this visit</button></p>
              </div>`;
            }).join('')}
          </div>` : ''}
          ${past.length ? `
          <details class="eh-sublist eh-past"${past.some(r => S.reviews.has(r.id)) ? ' open' : ''}><summary>Past and declined (${past.length})</summary>
            ${past.slice(0, 20).map(r => `
              <div class="eh-req-row">
                <span class="tc-chip ${r.status === 'confirmed' ? 'tc-chip-approved' : 'tc-chip-denied'}">${esc(r.status === 'confirmed' ? 'visited' : r.status)}</span>
                <strong>${esc(fmtDay(r.date))}</strong> ${esc(r.startTime || '')}
                — ${esc(r.requesterName || '')} <span class="tc-muted">${esc(r.requesterAffiliation || '')}</span>
                <span class="tc-muted">${esc(label(ACTIVITY_TYPES, r.activityType))}</span>
                ${r.status === 'confirmed' ? (reviewLine(S.reviews.get(r.id)) || '<p class="tc-muted">No review from the presenter yet.</p>') : ''}
              </div>`).join('')}
          </details>` : ''}
          ${nav('slots', false)}`;
      }
    };

    /* ---- navigation ---- */
    // Looked up from the document, not `root`: after a request decision
    // the host refresh has replaced the element this call was mounted in.
    function scrollToOpen() {
      const el = document.querySelector('.eh-teacher .eh-step.open');
      if (!el) return;
      const banner = parseFloat(getComputedStyle(document.documentElement)
        .getPropertyValue('--banner-height')) || 64;
      const top = el.getBoundingClientRect().top;
      if (top < banner + 8 || top > window.innerHeight * 0.55) {
        const calm = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
        el.scrollIntoView({ behavior: calm ? 'auto' : 'smooth', block: 'start' });
      }
      el.querySelector('.eh-step-head')?.focus({ preventScroll: true });
    }
    function go(id) {
      openStep = id;
      paint();
      scrollToOpen();
    }

    function readListingForm() {
      const q = (sel) => root.querySelector(sel);
      return listingOf({
        displayName: q('[data-ep-name]').value.trim(),
        school: q('[data-ep-school]').value.trim(),
        schoolType: root.querySelector('[data-ep-type]:checked')?.value || '',
        city: q('[data-ep-city]').value.trim(),
        gradeLevels: splitList(q('[data-ep-grades]').value),
        subjects: splitList(q('[data-ep-subjects]').value),
        classSize: Number(q('[data-ep-size]').value) || null,
        topics: splitList(q('[data-ep-topics]').value),
        activityTypes: [...root.querySelectorAll('[data-ep-activity]:checked')].map(i => i.value),
        formats: [...root.querySelectorAll('[data-ep-format]:checked')].map(i => i.value)
      });
    }
    function readContactForm() {
      const q = (sel) => root.querySelector(sel).value.trim();
      return contactOf({
        address: q('[data-ec-address]'), room: q('[data-ec-room]'),
        phone: q('[data-ec-phone]'), arrivalNotes: q('[data-ec-notes]')
      });
    }

    // Leaving a listing card: a draft saves; a listing already with the lab
    // only remembers the edit (see the header comment for why).
    async function listingNext(next) {
      const data = readListingForm();
      if (!S.autoSaves) {
        listingDraft = same(data, S.baseline) ? null : { uid, data };
        go(next);
        return;
      }
      if (S.profile && same(data, S.baseline)) { listingDraft = null; go(next); return; }
      try {
        await src().saveEngageProfile(uid, Object.assign({}, data), false);
        listingDraft = null;
        openStep = next;
        await reload();
        scrollToOpen();
        setStatus('Saved.');
      } catch (e) { setStatus('Could not save: ' + e.message, true); }
    }

    const NEXT = {
      about: () => {
        const d = readListingForm();
        if (!d.displayName || !d.school) { setStatus('Add your name and your school to go on.', true); return; }
        listingNext('class');
      },
      class: () => listingNext('kinds'),
      kinds: () => {
        const d = readListingForm();
        if (!d.activityTypes.length || !d.formats.length) {
          setStatus('Pick at least one kind of visit and one place.', true); return;
        }
        listingNext('location');
      },
      location: async () => {
        const data = readContactForm();
        if (same(data, S.contactBase)) { contactDraft = null; go('submit'); return; }
        try {
          await src().saveEngageContact(uid, data);
          contactDraft = null;
          openStep = 'submit';
          await reload();
          scrollToOpen();
          setStatus('Location saved. It stays private.');
        } catch (e) { setStatus('Could not save: ' + e.message, true); }
      },
      slots: () => go('visits')
    };

    // A request decision changes the host's tab badge, so the embedded
    // panel refreshes the whole hub; setStatus goes AFTER, because the
    // refresh rebuilds the element it writes to (the V3.771 lesson).
    async function afterDecision(msg) {
      if (opts && typeof opts.onChange === 'function') {
        keepPlace = true;
        await opts.onChange();
      } else {
        await reload();
      }
      scrollToOpen();
      setStatus(msg);
    }

    function wire() {
      const panel = root.querySelector('.eh-teacher');

      // Every keystroke lands in a draft, so a repaint (another card
      // opening, a time added, a request decided) never eats typing.
      panel.addEventListener('input', onEdit);
      panel.addEventListener('change', onEdit);
      function onEdit(ev) {
        const t = ev.target;
        if (!t.matches) return;
        if (t.matches('[data-ep-name],[data-ep-school],[data-ep-type],[data-ep-city],[data-ep-grades],[data-ep-subjects],[data-ep-size],[data-ep-topics],[data-ep-activity],[data-ep-format]')) {
          const d = readListingForm();
          listingDraft = same(d, S.baseline) ? null : { uid, data: d };
        } else if (t.matches('[data-ec-address],[data-ec-room],[data-ec-phone],[data-ec-notes]')) {
          const d = readContactForm();
          contactDraft = same(d, S.contactBase) ? null : { uid, data: d };
        }
      }

      panel.addEventListener('click', (ev) => {
        const toggle = ev.target.closest('[data-step-toggle]');
        if (toggle) {
          const id = toggle.closest('.eh-step').dataset.step;
          openStep = openStep === id ? '' : id;
          paint();
          if (openStep) scrollToOpen();
          else root.querySelector(`[data-step="${id}"] .eh-step-head`)?.focus({ preventScroll: true });
          return;
        }
        const gotoBtn = ev.target.closest('[data-goto]');
        if (gotoBtn) { go(gotoBtn.dataset.goto); return; }
        const nextBtn = ev.target.closest('[data-step-next]');
        if (nextBtn) {
          const id = nextBtn.closest('.eh-step').dataset.step;
          if (NEXT[id]) NEXT[id]();
        }
      });
      // Enter in a text field continues, like any form would. (The slot
      // and decide forms are real <form>s and submit themselves.)
      panel.querySelectorAll('.eh-step.open input:not([type=checkbox]):not([type=radio])').forEach(inp => {
        if (inp.closest('form') || inp.closest('.eh-calpanel')) return;
        inp.addEventListener('keydown', (ev) => {
          if (ev.key !== 'Enter') return;
          ev.preventDefault();
          panel.querySelector('.eh-step.open [data-step-next]')?.click();
        });
      });

      /* ---- card 5: send / discard ---- */
      panel.querySelector('[data-submit]')?.addEventListener('click', async () => {
        const data = readListingForm();
        const gap = !(data.displayName && data.school) ? ['about', 'Add your name and your school first.']
          : !(data.activityTypes.length && data.formats.length) ? ['kinds', 'Pick at least one kind of visit and one place first.']
          : null;
        if (gap) {
          openStep = gap[0]; paint(); scrollToOpen();
          setStatus(gap[1], true);
          return;
        }
        try {
          await src().saveEngageProfile(uid, Object.assign({}, data), true);
          listingDraft = null;
          openStep = 'submit';
          await reload();
          setStatus('Sent. The lab will review your listing.');
        } catch (e) { setStatus('Could not send: ' + e.message, true); }
      });
      panel.querySelector('[data-discard]')?.addEventListener('click', () => {
        listingDraft = null;
        paint();
        setStatus('Changes discarded. Your listing is as it was.');
      });

      /* ---- card 6: opportunities (V3.791) ---- */
      // The calendar: with the form open, a tap toggles that day in the
      // draft; with it closed, a tap starts a new opportunity on that day.
      const cal = panel.querySelector('.eh-teacher-cal .eh-cal');
      cal?.addEventListener('click', (e) => {
        const navBtn = e.target.closest('[data-cal-nav]');
        if (navBtn) {
          if (navBtn.disabled) return;
          const dir = navBtn.dataset.calNav;
          const d = new Date(calMonth.y, calMonth.m + Number(dir), 1);
          calMonth = { y: d.getFullYear(), m: d.getMonth() };
          paint();
          root.querySelector(`.eh-teacher-cal [data-cal-nav="${dir}"]`)?.focus({ preventScroll: true });
          return;
        }
        const cell = e.target.closest('[data-day]');
        if (!cell || cell.disabled) return;
        const iso = cell.dataset.day;
        if (S.prof.status !== 'approved') return;
        if (!oppForm) oppForm = newOppDraft(iso);
        else if (oppForm.dates.has(iso)) oppForm.dates.delete(iso);
        else oppForm.dates.set(iso, { ...oppForm.last });
        paint();
        root.querySelector(`.eh-teacher-cal [data-day="${iso}"]`)?.focus({ preventScroll: true });
      });
      panel.querySelector('[data-opp-new]')?.addEventListener('click', () => {
        oppForm = newOppDraft(null);
        paint();
        root.querySelector('#eh-of-title')?.focus({ preventScroll: true });
        root.querySelector('#eh-opp-form')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      });

      const form = panel.querySelector('#eh-opp-form');
      if (form) {
        const f = oppForm;
        // Every keystroke lands in the draft, so a calendar tap (a repaint)
        // never eats typing.
        form.addEventListener('input', (e) => {
          const t = e.target;
          if (t.matches('[data-of="title"]')) f.title = t.value;
          else if (t.matches('[data-of="topic"]')) f.topic = t.value;
          else if (t.matches('[data-of="subject"]')) f.ctx.subject = t.value;
          else if (t.matches('[data-of="grade"]')) f.ctx.grade = t.value;
          else if (t.matches('[data-of="size"]')) f.ctx.size = t.value;
          else if (t.matches('[data-of="wantedN"]')) { f.wanted = Math.max(2, Number(t.value) || 2); form.querySelector('[data-of-wanted][value="many"]').checked = true; }
          else if (t.matches('[data-of-start]') || t.matches('[data-of-end]')) {
            const iso = t.closest('[data-of-start], [data-of-end], .eh-opp-daterow').closest('.eh-opp-daterow').dataset.date;
            const cur = f.dates.get(iso) || { ...f.last };
            if (t.matches('[data-of-start]')) cur.start = t.value; else cur.end = t.value;
            f.dates.set(iso, cur);
            // The first date's time is the default for the ones added later.
            const firstIso = [...f.dates.keys()].sort()[0];
            if (iso === firstIso) f.last = { ...cur };
          }
        });
        form.addEventListener('change', (e) => {
          const t = e.target;
          if (t.matches('[data-of-act]')) { t.checked ? f.acts.add(t.value) : f.acts.delete(t.value); }
          else if (t.matches('[data-of-fmt]')) { t.checked ? f.fmts.add(t.value) : f.fmts.delete(t.value); }
          else if (t.matches('[data-of-wanted]')) {
            f.wanted = t.value === 'many' ? Math.max(2, Number(form.querySelector('[data-of="wantedN"]').value) || 3) : 1;
          }
        });
        form.querySelectorAll('[data-of-remove]').forEach(b => b.addEventListener('click', () => {
          f.dates.delete(b.closest('.eh-opp-daterow').dataset.date);
          paint();
        }));
        form.querySelector('[data-of-cancel]').addEventListener('click', () => { oppForm = null; paint(); });
        form.addEventListener('submit', async (ev) => {
          ev.preventDefault();
          const title = f.title.trim();
          if (!title) { setStatus('Give the opportunity a short title presenters will understand.', true); form.querySelector('#eh-of-title').focus(); return; }
          if (!f.acts.size || !f.fmts.size) { setStatus('Pick at least one kind of visit and one place.', true); return; }
          const dates = [...f.dates.entries()].sort((a, b) => a[0].localeCompare(b[0]));
          if (!dates.length) { setStatus('Tap at least one day on the calendar.', true); return; }
          const today = todayISO();
          for (const [iso, t] of dates) {
            if (iso < today) { setStatus(`${fmtDay(iso)} has already passed.`, true); return; }
            if (!t.start || !t.end || t.end <= t.start) { setStatus(`Check the times on ${fmtDay(iso)}: the end needs to be after the start.`, true); return; }
          }
          const data = {
            teacherUid: uid, title, activityTypes: [...f.acts], formats: [...f.fmts], topic: f.topic.trim(),
            classContext: { subject: String(f.ctx.subject || '').trim(), grade: String(f.ctx.grade || '').trim(), size: Number(f.ctx.size) || null },
            presentersWanted: f.wanted > 1 ? f.wanted : 1,
            dates: dates.map(([date, t]) => ({ date, startTime: t.start, endTime: t.end })),
            timezone: 'America/Phoenix'
          };
          if (!f.id) data.status = 'open';
          try {
            const id = f.id;
            await src().saveOpportunity(id, data);
            oppForm = null;
            await reload();
            setStatus(id ? 'Opportunity updated.' : `Posted. Presenters can sign up for "${title}" now.`);
          } catch (e) { setStatus('Could not save: ' + e.message, true); }
        });
      }

      panel.querySelectorAll('.eh-opp').forEach(card => {
        const o = S.oppById.get(card.dataset.opp);
        if (!o) return;
        card.querySelector('[data-opp-edit]')?.addEventListener('click', () => {
          oppForm = draftFromOpp(o);
          const first = oppNextDate(o) || oppLastDate(o);
          if (first) { const d = fromISO(first); calMonth = { y: d.getFullYear(), m: d.getMonth() }; }
          paint();
          root.querySelector('#eh-opp-form')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        });
        card.querySelector('[data-opp-toggle]')?.addEventListener('click', async () => {
          const pausing = o.status !== 'paused';
          try {
            await src().saveOpportunity(o.id, { status: pausing ? 'paused' : 'open' });
            await reload();
            setStatus(pausing ? 'Paused. Presenters won\'t see it until you resume it.' : 'Open for sign-up again.');
          } catch (e) { setStatus('Could not update: ' + e.message, true); }
        });
        card.querySelector('[data-opp-close]')?.addEventListener('click', async () => {
          try {
            const losers = S.requests.filter(x => x.opportunityId === o.id && x.status === 'pending');
            await Promise.all(losers.map(x => src().decideEngageRequest(x.id, 'declined', {
              teacherNote: 'This opportunity has enough presenters now. Thank you for offering — please look for another.'
            }).catch(() => {})));
            await src().saveOpportunity(o.id, { status: 'booked' });
            await reload();
            setStatus('Closed to new presenters.' + (losers.length ? ` ${plural(losers.length, 'waiting sign-up')} declined with a note.` : ''));
          } catch (e) { setStatus('Could not update: ' + e.message, true); }
        });
        card.querySelector('[data-opp-reopen]')?.addEventListener('click', async () => {
          try {
            await src().saveOpportunity(o.id, { status: 'open', bookedDate: null, acceptedRequestIds: [] });
            await reload();
            setStatus('Open for sign-up again.');
          } catch (e) { setStatus('Could not update: ' + e.message, true); }
        });
        const del = card.querySelector('[data-opp-delete]');
        del?.addEventListener('click', () => armConfirm(del, async () => {
          try {
            const losers = S.requests.filter(x => x.opportunityId === o.id && x.status === 'pending');
            await Promise.all(losers.map(x => src().decideEngageRequest(x.id, 'declined', {
              teacherNote: 'This opportunity was withdrawn. Thank you for offering — please look for another.'
            }).catch(() => {})));
            await src().deleteOpportunity(o.id);
            await reload();
            setStatus('Deleted.' + (losers.length ? ` ${plural(losers.length, 'waiting sign-up')} declined with a note.` : ''));
          } catch (e) { setStatus('Could not delete: ' + e.message, true); }
        }));
      });

      /* ---- card 7: request decisions ---- */
      panel.querySelectorAll('.eh-req-row [data-req-confirm], .eh-req-row [data-req-decline]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const row = btn.closest('.eh-req-row');
          const form = row.querySelector('.eh-decide-form');
          const confirm = btn.hasAttribute('data-req-confirm');
          form.dataset.decision = confirm ? 'confirmed' : 'declined';
          form.querySelector('[data-decide-go]').textContent = confirm ? 'Accept visit' : 'Decline request';
          form.querySelectorAll('[data-accept-only]').forEach(el => { el.hidden = !confirm; });
          const preview = form.querySelector('[data-preview]');
          if (confirm) {
            const contactNow = await src().getEngageContact(uid).catch(() => null);
            form._location = contactNow;
            const r = S.requests.find(x => x.id === row.dataset.req) || {};
            preview.innerHTML = r.format !== 'at-school'
              ? `<p class="tc-muted">Next you'll email the presenter when, where and how many students to expect.</p>`
              : contactNow && contactNow.address
                ? `<p class="tc-muted">Accepting shares your location details with the presenter:
                     <strong>${esc(contactNow.address)}</strong>${contactNow.room ? ' · ' + esc(contactNow.room) : ''}.
                     Next you'll email them when, where and how many students to expect.</p>`
                : `<p class="error-text">You haven't saved your school's address yet, so the presenter
                     will be accepted without one. If the visit is at your school, add it first.
                     <button type="button" class="btn btn-secondary btn-small" data-goto="location">Add your address (step 4)</button></p>`;
          } else {
            form._location = null;
            preview.innerHTML = '';
          }
          form.hidden = false;
        });
      });
      panel.querySelectorAll('.eh-decide-form').forEach(form => form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const row = form.closest('.eh-req-row');
        const decision = form.dataset.decision;
        const note = form.querySelector('[data-decide-note]').value.trim();
        const extras = {};
        if (note) extras.teacherNote = note;
        if (decision === 'confirmed' && form._location && form._location.address) {
          extras.location = form._location;
        }
        const r = S.requests.find(x => x.id === row.dataset.req) || {};
        const o = S.oppById.get(r.opportunityId) || null;
        if (decision === 'confirmed') {
          const n = Number(form.querySelector('[data-decide-students]').value);
          if (!n || n < 1) { setStatus('Say roughly how many students they should expect.', true); return; }
          extras.expectedStudents = n;
          // V3.791 — the teacher picks the date from the presenter's ticks.
          const pick = form.querySelector('[data-decide-date]:checked')?.value;
          if (!pick) { setStatus('Pick the date for the visit.', true); return; }
          const when = oppDates(o || {}).find(x => x.date === pick) || {};
          extras.date = pick;
          extras.startTime = when.startTime || r.startTime || '';
          extras.endTime = when.endTime || r.endTime || '';
        }
        try {
          await src().decideEngageRequest(row.dataset.req, decision, extras);
          // V3.791 — accepting books the opportunity: the date is fixed, and
          // once it has as many presenters as the teacher wanted it leaves
          // the sign-up list and the other sign-ups are declined with a note.
          if (decision === 'confirmed' && o) {
            const acceptedIds = [...new Set([...(o.acceptedRequestIds || []), r.id])];
            const wanted = o.presentersWanted || 1;
            const patch = { acceptedRequestIds: acceptedIds, bookedDate: o.bookedDate || extras.date };
            if (acceptedIds.length >= wanted) {
              patch.status = 'booked';
              const losers = S.requests.filter(x => x.opportunityId === o.id && x.status === 'pending' && x.id !== r.id);
              await Promise.all(losers.map(x => src().decideEngageRequest(x.id, 'declined', {
                teacherNote: 'Another presenter was accepted for this opportunity. Thank you for offering — please look for another.'
              }).catch(e => console.warn('[ENGAGE] auto-decline', e))));
            }
            await src().saveOpportunity(o.id, patch).catch(e => console.warn('[ENGAGE] book', e));
          }
          await afterDecision(decision === 'confirmed'
            ? 'Accepted. Your email to the presenter is ready below: copy it and send it from your own email.' : 'Request declined.');
          if (decision === 'confirmed') {
            document.querySelector(`.eh-teacher .eh-email[data-email="${row.dataset.req}"]`)
              ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
          }
        } catch (e) { setStatus('Could not save: ' + e.message, true); }
      }));

      /* ---- card 7: the confirmation email (V3.787) ---- */
      // The mailto opens the teacher's own mail app; the page can't know
      // whether it was sent, so opening it asks "Sent it?" and only the
      // teacher's yes writes emailedAt. The repaint waits a beat so it never
      // removes the link before the browser has followed it.
      // V3.790 — copying (or opening the mail app) promotes "Yes, I sent it"
      // to the primary button in place. Nothing here repaints, so the teacher's
      // edits and caret stay put.
      const markComposed = (block) => {
        const id = block.dataset.email;
        composed.add(id);
        const b = block.querySelector('[data-mark-emailed]');
        if (b) { b.classList.remove('btn-secondary'); b.classList.add('btn-primary'); }
      };
      async function copyText(text, fallbackEl) {
        try { await navigator.clipboard.writeText(text); return true; } catch (e) { /* fall back */ }
        if (fallbackEl && fallbackEl.select) {
          fallbackEl.focus(); fallbackEl.select();
          try { return document.execCommand('copy'); } catch (e) { return false; }
        }
        return false;
      }
      panel.querySelectorAll('.eh-email').forEach(block => {
        const id = block.dataset.email;
        const r = S.requests.find(x => x.id === id);
        const parts = r && visitEmailParts(r);
        if (!parts) return;
        const ta = block.querySelector('[data-email-body]');
        const link = block.querySelector('[data-compose]');
        const reset = block.querySelector('[data-reset-email]');
        const note = block.querySelector('.eh-email-copied');
        const sync = () => {
          link.dataset.href = mailtoOf(parts.to, parts.subject, ta.value);
          reset.hidden = ta.value === parts.body;
        };
        ta.addEventListener('input', () => {
          if (ta.value === parts.body) emailEdits.delete(id); else emailEdits.set(id, ta.value);
          sync();
        });
        reset.addEventListener('click', () => { emailEdits.delete(id); ta.value = parts.body; sync(); });
        // A button, not an <a>: it should look secondary to "Copy the email".
        link.addEventListener('click', () => {
          if (!r.emailedAt) markComposed(block);
          window.location.href = link.dataset.href;
        });
        block.querySelectorAll('[data-copy]').forEach(btn => btn.addEventListener('click', async () => {
          const what = btn.dataset.copy;
          const text = what === 'to' ? parts.to : what === 'subject' ? parts.subject : ta.value;
          const ok = await copyText(text, what === 'body' ? ta : null);
          const old = btn.textContent;
          btn.textContent = ok ? 'Copied ✓' : 'Copy failed';
          setTimeout(() => { btn.textContent = old; }, 1600);
          note.textContent = ok
            ? (what === 'body' ? `Copied. Paste it into a new email to ${parts.to}.` : 'Copied.')
            : 'Your browser blocked copying. Select the text and copy it yourself.';
          if (ok && what === 'body' && !r.emailedAt) markComposed(block);
        }));
      });
      panel.querySelectorAll('[data-mark-emailed]').forEach(btn => btn.addEventListener('click', async () => {
        const id = btn.closest('.eh-req-row').dataset.req;
        try {
          await src().markEngageEmailed(id);
          composed.delete(id);
          await afterDecision('Marked as sent. The presenter has everything they need.');
        } catch (e) { setStatus('Could not save: ' + e.message, true); }
      }));
      panel.querySelectorAll('[data-cancel-visit]').forEach(btn => btn.addEventListener('click', () =>
        armConfirm(btn, async () => {
          const id = btn.closest('.eh-req-row').dataset.req;
          const r = S.requests.find(x => x.id === id) || {};
          try {
            await src().decideEngageRequest(id, 'cancelled', {});
            // V3.791 — un-book: take this presenter off the opportunity; if
            // nobody is left, the date is free again and it reopens for
            // sign-up (dates permitting).
            const o = S.oppById.get(r.opportunityId);
            if (o) {
              const left = (o.acceptedRequestIds || []).filter(x => x !== id);
              const patch = { acceptedRequestIds: left };
              if (!left.length) patch.bookedDate = null;
              if (o.status === 'booked' && oppNextDate(o)) patch.status = 'open';
              await src().saveOpportunity(o.id, patch).catch(e => console.warn('[ENGAGE] unbook', e));
            }
            await afterDecision('Visit cancelled. The presenter is told, and the opportunity is open for sign-up again.');
          } catch (e) { setStatus('Could not cancel: ' + e.message, true); }
        })));
    }

    await reload();
  }

  /* ================================================================
     EXPORTS
     ================================================================ */
  ML.renderEngageHub = renderEngageHub;
  ML.wireEngageHub = wireEngageHub;
  // V3.769 — the teaching hub mounts this same teacher panel as its
  // Engagement tab; see renderTeacherHub for the opts contract.
  ML.mountEngageTeacherPanel = (container, opts) => renderTeacherHub(container, opts);
  // V3.785 — shared with engage-presenters.js (the presenter page).
  ML.EngageKit = {
    esc, WEEKDAYS, ACTIVITY_TYPES, FORMATS, SCHOOL_TYPES, label,
    isoLocal, fromISO, addDays, todayISO, fmtDay,
    listingHeadHTML, ctxLine, monthGridHTML, armConfirm,
    reqWhen, oppDates, oppNextDate, oppLastDate, oppDatesLine,
    // V3.808 — the confirmation email + its mailto, for engage-guest.js
    buildVisitEmail, mailtoOf: kitMailtoOf
  };
})();
