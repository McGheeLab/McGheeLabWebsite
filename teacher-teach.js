/* ================================================================
   TEACHER TEACHING HUB — #/teach (V3.669, four-tab rebuild V3.769)
   ----------------------------------------------------------------
   The class-management surface for external teachers, split out of
   the #/dashboard card stack (which keeps a slim summary + link).

   Routes (hash segments after #/teach):
     #/teach                        — the most recent class, Dashboard tab
     #/teach/{scheduleId}           — that class, Dashboard tab
     #/teach/{scheduleId}/dashboard — read-only overview; every figure
                                      links to the tab that manages it
     #/teach/{scheduleId}/students  — enrolment, invites, roster +
                                      per-student progress
     #/teach/{scheduleId}/modules   — what students get (ordered), and the
                                      library to choose it from, one card
                                      per course
     #/teach/{scheduleId}/engagement— classroom availability for outreach
                                      visits (engage-hub.js's teacher panel
                                      mounted here, not rebuilt)
   Older tab names still resolve — see TAB_ALIASES.

   Also renders the #/teachers onboarding landing (V3.680) at the foot
   of this file.

   Data access goes through teacher-classes.js's TC_DB via the same
   src()/me()/myProfile() demo seam, so #/demo teacher personas render
   this page against fixtures with nothing written to Firestore.

   No window.prompt/alert/confirm anywhere — destructive buttons arm an
   inline confirm pair, and errors land in the page status line.

   Loaded after teacher-classes.js, before teacher-demo.js.
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
  function fmtDate(v) {
    const d = v?.toDate ? v.toDate() : (v ? new Date(v) : null);
    return d && !isNaN(d) ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
  }
  function fmtDue(d) {
    const dt = d ? new Date(d + 'T00:00') : null;
    return dt && !isNaN(dt) ? dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
  }
  function waitForAuth() {
    const Auth = ML.Auth;
    if (!Auth || Auth._authStateResolved) return Promise.resolve();
    return new Promise(resolve => {
      const once = () => { Auth.offChange(once); resolve(); };
      Auth.onChange(once);
    });
  }

  function setStatus(msg, isErr) {
    const el = document.getElementById('teach-status');
    if (!el) return;
    el.textContent = msg || '';
    el.className = 'teach-status' + (isErr ? ' error-text' : '');
    el.hidden = !msg;
    clearTimeout(setStatus._t);
    if (msg && !isErr) setStatus._t = setTimeout(() => { el.hidden = true; }, 3500);
  }

  // Inline destructive confirm: first click swaps the button into a
  // "Sure? ✓ / ✕" pair in place; ✓ runs the action, ✕ (or 6s) restores.
  function armConfirm(btn, onYes) {
    if (btn.dataset.armed) return;
    btn.dataset.armed = '1';
    const original = btn.innerHTML;
    btn.innerHTML = 'Sure? <b>✓</b>';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = btn.className;
    cancel.textContent = '✕';
    btn.after(cancel);
    const restore = () => {
      clearTimeout(t);
      delete btn.dataset.armed;
      btn.innerHTML = original;
      cancel.remove();
      btn.removeEventListener('click', yes);
    };
    const t = setTimeout(restore, 6000);
    const yes = (e) => { e.stopPropagation(); restore(); onYes(); };
    btn.addEventListener('click', yes);
    cancel.addEventListener('click', (e) => { e.stopPropagation(); restore(); });
  }

  /* ================================================================
     FOUR-TAB HUB (V3.769)
     ----------------------------------------------------------------
     Alex: "the current teacher hub is hard to navigate, lets split
     everything up we can do here into tabs."

     One always-visible tab bar per class plus a class switcher in the
     header, replacing the V3.669 class-list page + five-tab drill-in
     (two levels of navigation, and the engagement hub off on its own
     page entirely):

       Dashboard  — read-only overview; every figure links to the tab
                    that manages it
       Students   — enrolment, invites, roster, per-student progress
       Modules    — the ordered list students get + the library it is
                    chosen from (V3.771: one card per course)
       Engagement — classroom availability for outreach visits (the
                    teacher side of #/engage, mounted here)

     One load per view: loadHub() fetches the teacher's class data once
     and every tab renders from it, so switching tabs costs no reads
     and the tab badges are always in step with the tab contents.
     ================================================================ */
  const TABS = [
    { id: 'dashboard',  label: 'Dashboard' },
    { id: 'students',   label: 'Students' },
    { id: 'modules',    label: 'Modules' },
    { id: 'engagement', label: 'Engagement' }
  ];
  // The V3.669-673 tab names stay valid so old deep links (and the
  // gradebook link in the submission notification) still land somewhere
  // sensible instead of 404ing into the dashboard silently.
  const TAB_ALIASES = {
    assignments: 'modules', catalog: 'modules',
    gradebook: 'students', progress: 'students', roster: 'students',
    overview: 'dashboard', visits: 'engagement'
  };
  function normalizeTab(raw) {
    const t = String(raw || '').toLowerCase();
    const mapped = TAB_ALIASES[t] || t;
    return TABS.some(x => x.id === mapped) ? mapped : 'dashboard';
  }

  const byOrder = (a, b) => (a.order ?? 0) - (b.order ?? 0);
  const byName = (a, b) =>
    String(a.studentName || '').localeCompare(String(b.studentName || ''));
  function millis(v) { return v?.toMillis?.() ?? (v ? new Date(v).getTime() : 0); }
  // V3.787 — LOCAL date: toISOString() is UTC, which in Arizona rolls over
  // to tomorrow at 5pm (same fix as engage-hub.js isoLocal).
  function todayISO() {
    const d = new Date(), p2 = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
  }
  function fmtAgo(v) {
    const ms = millis(v);
    if (!ms) return null;
    const days = Math.floor((Date.now() - ms) / 86400000);
    if (days <= 0) return 'today';
    if (days === 1) return 'yesterday';
    return days + ' days ago';
  }
  function noun(n, one, many) { return n === 1 ? one : (many || one + 's'); }
  function plural(n, one, many) { return n + ' ' + noun(n, one, many); }

  /* ================================================================
     RENDER (skeleton — wire fills it once auth + data resolve)
     ================================================================ */
  function renderTeachPage() {
    return `<div class="dashboard-page teach-page" id="teach-root">
      <p class="loading-text">Loading your classes…</p>
    </div>`;
  }

  async function wireTeachPage(subParts) {
    const root = document.getElementById('teach-root');
    if (!root) return;
    await waitForAuth();

    const signedIn = demo() ? !demo().signedOut : !!ML.Auth?.currentUser;
    if (!signedIn) {
      root.innerHTML = `<div class="dash-card tc-gate-card">
        <h3>Teaching dashboard</h3>
        <p class="tc-muted">Sign in with the Google account you used for your class request.</p>
        <p><a class="btn btn-primary" href="#/login">Sign in</a></p>
      </div>`;
      return;
    }
    const p = myProfile();
    const isAdmin = !demo() && p.role === 'admin';
    if (p.category !== 'teacher' && !isAdmin) {
      root.innerHTML = `<div class="dash-card tc-gate-card">
        <h3>Teaching dashboard</h3>
        <p class="tc-muted">This page is for teachers running a class with our modules.
          Want to bring them to your classroom?</p>
        <p><a class="btn btn-primary" href="#/teachers">For teachers &rarr;</a></p>
      </div>`;
      return;
    }

    const wantId = ((subParts && subParts[0]) || '').split('?')[0];
    const tab = normalizeTab(((subParts && subParts[1]) || '').split('?')[0]);
    try {
      const classes = ((await src().myTeacherClasses(me())) || [])
        .slice().sort((a, b) => millis(b.createdAt) - millis(a.createdAt));

      // No class in the URL → the most recent one. The switcher in the
      // header and the Dashboard's other-classes strip reach the rest, so
      // there is no separate list page to get lost in any more.
      const schedule = wantId
        ? await src().getSchedule(wantId).catch(() => null)
        : (classes[0] || null);

      if (!schedule) {
        root.innerHTML = classes.length || wantId ? `
          <div class="dash-card"><h3>Class not found</h3>
            <p class="tc-muted">This class doesn't exist or isn't yours.</p>
            <p><a class="btn btn-secondary" href="#/teach">&larr; My classes</a></p></div>`
          : noClassesHTML();
        return;
      }
      const mayManage = schedule.kind === 'teacher-class' &&
        (schedule.ownerUid === me() || isAdmin);
      if (!mayManage) {
        root.innerHTML = `<div class="dash-card"><h3>Class not found</h3>
          <p class="tc-muted">This class doesn't exist or isn't yours.</p>
          <p><a class="btn btn-secondary" href="#/teach">&larr; My classes</a></p></div>`;
        return;
      }
      await renderHub(root, classes, schedule, tab);
    } catch (e) {
      console.warn('[TEACH]', e);
      root.innerHTML = `<div class="dash-card"><h3>Teaching dashboard</h3>
        <p class="error-text">Failed to load: ${esc(e.message || e)}</p></div>`;
    }
  }

  function noClassesHTML() {
    return `
      <div class="dash-header"><h2>Teaching Dashboard</h2></div>
      <div class="dash-card"><h3>No classes yet</h3>
        <p class="tc-muted">Once the lab approves your class request, it appears here with a
          join code for your students.</p>
        <p><a class="btn btn-primary" href="#/teachers">Request a class</a>
           <a class="btn btn-secondary" href="#/dashboard">My profile</a></p>
      </div>`;
  }

  function wireCopyButtons(scope) {
    scope.querySelectorAll('[data-copy-code]').forEach(btn => {
      btn.addEventListener('click', () => {
        navigator.clipboard?.writeText(btn.dataset.copyCode);
        const old = btn.textContent;
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = old; }, 1500);
      });
    });
  }

  /* ================================================================
     ONE LOAD PER VIEW
     ----------------------------------------------------------------
     Every teacher query is keyed on teacherUid (that is what the list
     rules can prove — see V3.671), so one pass fetches the teacher's
     whole world and each tab filters it down to this class. Engagement
     requests are per-TEACHER, not per-class, so they are deliberately
     not filtered by scheduleId.
     ================================================================ */
  async function loadHub(schedule) {
    const owner = schedule.ownerUid;
    const sid = schedule.id;
    const D = src();
    const maybe = (fn, ...args) =>
      (typeof D[fn] === 'function' ? D[fn](...args) : Promise.resolve([])).catch(() => []);

    const [codes, roster, stats, engageReqs] = await Promise.all([
      maybe('myJoinCodes', owner),
      maybe('rosterForTeacher', owner),
      maybe('statsForTeacher', owner),
      maybe('engageRequestsForTeacher', owner)
    ]);

    const hub = {
      activeCode: codes.find(c => c.scheduleId === sid && c.active) || null,
      roster: roster.filter(r => r.scheduleId === sid).sort(byName),
      stats: stats.filter(s => s.scheduleId === sid),
      engageReqs,
      modules: (schedule.modules || []).slice().sort(byOrder)
    };
    // V3.771 dropped per-module visibility, so everything in modules[] is
    // live. The filter stays only to hide a module a pre-V3.771 class had
    // hidden — the next save rewrites it as visible and it drains away.
    hub.visibleModules = hub.modules.filter(m => m.published !== false);
    hub.active = hub.roster.filter(r => r.status === 'active');
    hub.pendingVisits = hub.engageReqs.filter(r => r.status === 'pending').length;
    // V3.787 — accepting a visit isn't finished until the teacher has emailed
    // the presenter when, where and how many students to expect.
    hub.owedEmails = hub.engageReqs.filter(r => r.status === 'confirmed' && !r.emailedAt &&
      String(r.date || '') >= todayISO()).length;
    hub.upcomingVisits = hub.engageReqs
      .filter(r => r.status === 'confirmed' && String(r.date || '') >= todayISO())
      .sort((a, b) => String(a.date).localeCompare(String(b.date)));
    hub.statsFor = (uid) => hub.stats.find(x => x.studentUid === uid) || null;
    hub.quiet = hub.active.filter(s => {
      const last = millis(hub.statsFor(s.studentUid)?.lastActiveAt);
      return !last || (Date.now() - last) > 7 * 86400000;
    });
    return hub;
  }

  async function renderHub(root, classes, schedule, tab) {
    const hub = await loadHub(schedule);
    root.innerHTML = shellHTML(classes, schedule, tab, hub);
    wireCopyButtons(root);

    document.getElementById('teach-class-switch')?.addEventListener('change', (e) => {
      window.location.hash = '#/teach/' + e.target.value + '/' + tab;
    });

    const body = document.getElementById('teach-tab-body');
    const ctx = {
      root, classes, schedule, hub, tab,
      // A mutation refetches the schedule too — module edits live on it.
      refresh: async () => {
        const fresh = (await src().getSchedule(schedule.id).catch(() => null)) || schedule;
        await renderHub(root, classes, fresh, tab);
      }
    };
    if (tab === 'students') await renderStudentsTab(body, ctx);
    else if (tab === 'modules') await renderModulesTab(body, ctx);
    else if (tab === 'engagement') await renderEngagementTab(body, ctx);
    else await renderDashboardTab(body, ctx);
  }

  function shellHTML(classes, schedule, tab, hub) {
    const sid = schedule.id;
    const badge = { engagement: hub.pendingVisits + hub.owedEmails };
    return `
      <div class="dash-header teach-header">
        <div class="teach-header-main">
          <h2>${esc(schedule.title || sid)}</h2>
          <p class="tc-muted">${esc([schedule.school, schedule.semester].filter(Boolean).join(' — '))}</p>
        </div>
        <div class="teach-header-actions">
          ${classes.length > 1 ? `
            <label class="teach-class-switch">Class
              <select id="teach-class-switch" aria-label="Switch class">
                ${classes.map(c => `<option value="${esc(c.id)}"${c.id === sid ? ' selected' : ''}>${esc(c.title || c.id)}</option>`).join('')}
              </select>
            </label>` : ''}
          <a class="btn btn-secondary btn-small" href="#/classes/${esc(sid)}">Class page</a>
          <a class="btn btn-secondary btn-small" href="#/dashboard">My profile</a>
        </div>
      </div>
      <div id="teach-status" class="teach-status" hidden></div>
      <nav class="teach-tabs" role="tablist" aria-label="Class sections">
        ${TABS.map(t => `
          <a class="teach-tab${t.id === tab ? ' on' : ''}" role="tab"
             aria-selected="${t.id === tab ? 'true' : 'false'}"
             href="#/teach/${esc(sid)}/${t.id}">${esc(t.label)}${
            badge[t.id] ? `<span class="teach-tab-badge">${badge[t.id]}</span>` : ''}</a>`).join('')}
      </nav>
      <div id="teach-tab-body"><p class="loading-text">Loading…</p></div>`;
  }

  /* ================================================================
     TAB 1 — DASHBOARD (read-only; every number links to its tab)
     ================================================================ */
  async function renderDashboardTab(body, ctx) {
    const { schedule, hub, classes } = ctx;
    const sid = schedule.id;
    const to = (tab) => `#/teach/${esc(sid)}/${tab}`;
    const today = todayISO();

    // The tile prints the number itself, so the label carries only the noun.
    const visits = hub.upcomingVisits.length + hub.pendingVisits;
    const tiles = [
      { n: hub.active.length, label: noun(hub.active.length, 'student') + ' enrolled', tab: 'students' },
      { n: hub.visibleModules.length, label: noun(hub.visibleModules.length, 'module') + ' available', tab: 'modules' },
      { n: visits, label: 'engagement ' + noun(visits, 'visit'), tab: 'engagement' }
    ];

    // Everything with a date on it, in one list. Since V3.771 that is
    // classroom visits — modules carry no due dates and coursework is the
    // teacher's own business.
    const soon = [];
    for (const v of hub.upcomingVisits) {
      soon.push({
        date: v.date, kind: 'Visit', tab: 'engagement',
        what: [v.requesterName, v.activityType].filter(Boolean).join(' — ') +
              (v.startTime ? ' at ' + v.startTime : '')
      });
    }
    soon.sort((a, b) => String(a.date).localeCompare(String(b.date)));

    const todo = [];
    if (!hub.activeCode) todo.push({ text: 'No join code is active — students cannot join.', tab: 'students', cta: 'Create a code' });
    if (schedule.enrollmentOpen === false) todo.push({ text: 'Enrolment is closed for this class.', tab: 'students', cta: 'Open enrolment' });
    if (!hub.visibleModules.length) todo.push({ text: 'No modules are available yet — students see an empty class page.', tab: 'modules', cta: 'Choose modules' });
    if (hub.pendingVisits) todo.push({ text: plural(hub.pendingVisits, 'visit request') + ' waiting on your answer.', tab: 'engagement', cta: 'Review requests' });
    if (hub.owedEmails) todo.push({ text: (hub.owedEmails === 1 ? 'A visit you accepted still needs' : hub.owedEmails + ' visits you accepted still need') + ' your email to the presenter.', tab: 'engagement', cta: 'Send the email' });
    if (hub.active.length && hub.quiet.length) todo.push({ text: plural(hub.quiet.length, 'student') + " haven't opened a module in over a week.", tab: 'students', cta: 'See progress' });

    const classUrl = 'mcgheelab.com/#/classes/' + sid;

    body.innerHTML = `
      <div class="teach-tiles">
        ${tiles.map(t => `
          <a class="teach-tile" href="${to(t.tab)}">
            <span class="teach-tile-n">${t.n}</span>
            <span class="teach-tile-label">${esc(t.label)}</span>
          </a>`).join('')}
      </div>

      <div class="dash-card">
        <h3>Needs your attention</h3>
        ${todo.length ? `<ul class="teach-todo">
          ${todo.map(t => `<li><span>${esc(t.text)}</span>
            <a class="btn btn-secondary btn-small" href="${to(t.tab)}">${esc(t.cta)} &rarr;</a></li>`).join('')}
        </ul>` : '<p class="tc-muted">Nothing needs you right now — your class is set up and up to date.</p>'}
      </div>

      <div class="dash-card">
        <h3>Coming up</h3>
        ${soon.length ? `<ul class="teach-soon">
          ${soon.slice(0, 8).map(s => `<li>
            <span class="teach-soon-date">${esc(fmtDue(s.date))}</span>
            <span class="tc-chip tc-chip-draft">${esc(s.kind)}</span>
            <span class="teach-soon-what">${esc(s.what)}</span>
            <a class="teach-soon-link" href="${to(s.tab)}">manage &rarr;</a>
          </li>`).join('')}
        </ul>${soon.length > 8 ? `<p class="tc-muted">…and ${soon.length - 8} more.</p>` : ''}`
        : '<p class="tc-muted">Nothing scheduled. Classroom visits you confirm show up here.</p>'}
      </div>

      <div class="dash-card">
        <h3>Class access</h3>
        <p>Join code:
          ${hub.activeCode
            ? `<span class="tc-code">${esc(hub.activeCode.code)}</span>
               <button class="btn btn-secondary btn-small" data-copy-code="${esc(hub.activeCode.code)}">Copy</button>`
            : '<em class="tc-muted">none active</em>'}
          &nbsp;·&nbsp; Enrolment: ${schedule.enrollmentOpen !== false ? 'open' : '<strong>closed</strong>'}
        </p>
        <p class="tc-muted">Students go to <a href="#/classes/${esc(sid)}">${esc(classUrl)}</a>,
          sign in with Google, and enter the code.</p>
        <p><a class="btn btn-secondary btn-small" href="${to('students')}">Manage enrolment &amp; invites &rarr;</a></p>
      </div>

      ${classes.length > 1 ? `
      <div class="dash-card">
        <h3>Your other classes</h3>
        <ul class="teach-other-classes">
          ${classes.filter(c => c.id !== sid).map(c => `
            <li><a href="#/teach/${esc(c.id)}/dashboard">${esc(c.title || c.id)}</a>
              <span class="tc-muted">${esc([c.school, c.semester].filter(Boolean).join(' — '))}</span></li>`).join('')}
        </ul>
      </div>` : ''}`;

    wireCopyButtons(body);
  }

  /* ================================================================
     TAB 2 — STUDENTS (enrolment · invites · roster · progress)
     ----------------------------------------------------------------
     V3.771 removed the gradebook and the per-student module overrides
     with it: the site's job is to make modules available to a class and
     show who is working through them. How a teacher sets work and marks
     it is theirs. `assignments` / `submissions` / `setModuleOverride`
     still exist in TC_DB and in the rules — nothing was undeployed — so
     restoring either surface is re-adding its render call.
     ================================================================ */
  function moduleProgress(md) {
    // Rail modules report sections-seen / rail count; others scroll depth.
    if (!md) return 0;
    if (md.railCount) return Math.min(100, Math.round(Object.keys(md.sections || {}).length / md.railCount * 100));
    return Math.min(100, md.scrollPct || 0);
  }

  async function renderStudentsTab(body, ctx) {
    const { schedule, hub } = ctx;
    const sid = schedule.id;
    const classUrl = 'https://mcgheelab.com/#/classes/' + sid;
    const code = hub.activeCode ? hub.activeCode.code : '';
    const teacherName = schedule.teacherName || myProfile().name || 'your teacher';

    body.innerHTML = `
      <div class="dash-card">
        <h3>Invite students</h3>
        <p class="tc-muted">Students need two things: your class link and the join code. They sign
          in with Google on the class page and enter the code — there is nothing to install.</p>
        <div class="teach-invite-grid">
          <div class="teach-invite-field">
            <label>Class link</label>
            <div class="teach-invite-row">
              <code class="teach-invite-url">${esc(classUrl)}</code>
              <button class="btn btn-secondary btn-small" data-copy-code="${esc(classUrl)}">Copy</button>
            </div>
          </div>
          <div class="teach-invite-field">
            <label>Join code</label>
            <div class="teach-invite-row">
              ${code
                ? `<span class="tc-code">${esc(code)}</span>
                   <button class="btn btn-secondary btn-small" data-copy-code="${esc(code)}">Copy</button>
                   <button class="btn btn-secondary btn-small" id="teach-regen-code" data-old="${esc(code)}">Regenerate</button>
                   <button class="btn btn-secondary btn-small" id="teach-disable-code" data-code="${esc(code)}">Disable</button>`
                : `<span class="tc-muted">No active join code.</span>
                   <button class="btn btn-primary btn-small" id="teach-new-code">Create join code</button>`}
            </div>
          </div>
        </div>
        <p><label class="tc-toggle"><input type="checkbox" id="teach-enroll-toggle"
          ${schedule.enrollmentOpen !== false ? 'checked' : ''}> Enrolment open
          <span class="tc-muted">— turn this off once everyone has joined.</span></label></p>

        <div class="teach-invite-mail">
          <label for="teach-invite-emails">Email the invite</label>
          <p class="tc-muted">Paste your students' email addresses (commas or new lines). This opens
            your own mail app with the invite written for you — addresses go in BCC, so students
            don't see each other's.</p>
          <textarea id="teach-invite-emails" rows="2"
            placeholder="student1@school.edu, student2@school.edu"></textarea>
          <p><a class="btn btn-primary btn-small" id="teach-invite-compose" href="#">${ICON.svg('envelope')} Compose invite email</a>
             <button class="btn btn-secondary btn-small" id="teach-copy-instructions">Copy joining instructions</button></p>
        </div>
      </div>

      <div class="dash-card">
        <h3>Roster &amp; progress (${hub.active.length} active)</h3>
        <p class="tc-muted">Time counts only while the lesson is actually on screen. Progress is how
          far through a lesson a student has been. Students who haven't opened anything in over a
          week are flagged.</p>
        ${hub.roster.length ? `
        <div class="teach-roster">
          ${hub.roster.map(s => studentRowHTML(s, hub)).join('')}
        </div>` : '<p class="tc-muted">No students have joined yet — share the link and code above.</p>'}
      </div>`;

    wireCopyButtons(body);
    wireEnrolmentControls(ctx);
    wireInviteMail(body, { classUrl, code, className: schedule.title || sid, teacherName });
    wireRosterRows(body, ctx);
  }

  function studentRowHTML(s, hub) {
    const st = hub.statsFor(s.studentUid);
    const mods = st?.modules || {};
    const touched = hub.visibleModules.filter(m => mods[m.id]).length;
    const totalMin = Math.round(Object.values(mods).reduce((sum, m) => sum + (m.seconds || 0), 0) / 60);
    const ago = fmtAgo(st?.lastActiveAt);
    const last = millis(st?.lastActiveAt);
    const quiet = !last || (Date.now() - last) > 7 * 86400000;

    return `
      <div class="teach-student-row" data-enroll="${esc(s.id)}">
        <div class="teach-student-main">
          <strong>${esc(s.studentName || '—')}</strong>
          <span class="tc-muted">${esc(s.studentEmail || '')}</span>
          <span class="tc-muted">joined ${fmtDate(s.createdAt)}</span>
          ${s.status !== 'active' ? '<span class="tc-chip tc-chip-denied">Removed</span>' : ''}
        </div>
        <div class="teach-student-stats">
          <span class="teach-eng-last${quiet && s.status === 'active' ? ' quiet' : ''}">${
            ago ? 'active ' + esc(ago) : 'never opened a module'}</span>
          <span class="tc-muted">${touched}/${hub.visibleModules.length} modules · ${totalMin} min</span>
        </div>
        <div class="teach-student-actions">
          <button class="btn btn-secondary btn-small" data-viewas="${esc(s.studentUid)}"
            data-name="${esc(s.studentName || s.studentEmail || '')}" data-status="${esc(s.status)}">${ICON.svg('eye')} View as</button>
          <button class="btn btn-secondary btn-small" data-panel-toggle="progress">Progress</button>
          ${s.status === 'active' ? `<button class="btn btn-secondary btn-small" data-remove="${esc(s.id)}">Remove</button>` : ''}
        </div>
        <div class="teach-student-panel" data-panel="progress" hidden>
          ${hub.visibleModules.length ? hub.visibleModules.map(m => {
            const md = mods[m.id];
            const pct = moduleProgress(md);
            const min = md ? Math.round((md.seconds || 0) / 60) : 0;
            return `
            <div class="teach-eng-mod">
              <span class="teach-eng-mod-title">${esc(m.title || m.htmlFile)}</span>
              <span class="teach-eng-bar"><span class="teach-eng-fill" style="width:${pct}%"></span></span>
              <span class="tc-muted">${md ? `${pct}% · ${plural(md.opens || 0, 'open')} · ${min} min` : 'not opened'}</span>
            </div>`;
          }).join('') : '<p class="tc-muted">Make some modules available first — progress is per module.</p>'}
        </div>
      </div>`;
  }

  function wireEnrolmentControls(ctx) {
    const { schedule } = ctx;
    const sid = schedule.id;
    document.getElementById('teach-enroll-toggle')?.addEventListener('change', async (e) => {
      try {
        await src().setEnrollmentOpen(sid, e.target.checked);
        schedule.enrollmentOpen = e.target.checked;
        setStatus(e.target.checked ? 'Enrolment opened.' : 'Enrolment closed.');
      } catch (err) {
        e.target.checked = !e.target.checked;
        setStatus('Could not update: ' + err.message, true);
      }
    });
    document.getElementById('teach-new-code')?.addEventListener('click', async (e) => {
      e.target.disabled = true;
      try { await src().createJoinCode(sid, schedule.ownerUid); await ctx.refresh(); }
      catch (err) { e.target.disabled = false; setStatus('Could not create code: ' + err.message, true); }
    });
    const regen = document.getElementById('teach-regen-code');
    regen?.addEventListener('click', () => armConfirm(regen, async () => {
      try {
        await src().createJoinCode(sid, schedule.ownerUid);
        await src().deactivateCode(regen.dataset.old);
        await ctx.refresh();
        setStatus('New code created — the old one stopped working.');
      } catch (err) { setStatus('Could not regenerate: ' + err.message, true); }
    }));
    const disable = document.getElementById('teach-disable-code');
    disable?.addEventListener('click', () => armConfirm(disable, async () => {
      try { await src().deactivateCode(disable.dataset.code); await ctx.refresh(); }
      catch (err) { setStatus('Could not disable: ' + err.message, true); }
    }));
  }

  // The invite email is a mailto: the teacher's own mail app sends it —
  // there is no outbound mail server anywhere in this project by design.
  function wireInviteMail(body, info) {
    const ta = document.getElementById('teach-invite-emails');
    const link = document.getElementById('teach-invite-compose');
    if (!ta || !link) return;
    const instructions =
      `Go to ${info.classUrl}\n` +
      `Sign in with Google, then enter the class code: ${info.code || '(ask your teacher)'}`;
    const body_ = `Hi,\n\nWe're using the McGhee Lab interactive science modules in ` +
      `${info.className}.\n\nTo join the class:\n` +
      `1. Go to ${info.classUrl}\n` +
      `2. Sign in with Google (any account works)\n` +
      `3. Enter the class code: ${info.code || '(ask your teacher)'}\n\n` +
      `See you there,\n${info.teacherName}`;
    const subject = 'Join our class: ' + info.className;

    const build = () => {
      const bcc = ta.value.split(/[\s,;]+/).map(s => s.trim()).filter(s => s.includes('@'));
      link.href = 'mailto:?bcc=' + encodeURIComponent(bcc.join(',')) +
        '&subject=' + encodeURIComponent(subject) +
        '&body=' + encodeURIComponent(body_);
      ICON.label(link, 'envelope', bcc.length
        ? ` Compose invite to ${plural(bcc.length, 'student')}`
        : ' Compose invite email');
    };
    build();
    ta.addEventListener('input', build);

    document.getElementById('teach-copy-instructions')?.addEventListener('click', (e) => {
      navigator.clipboard?.writeText(instructions);
      const b = e.currentTarget;
      const old = b.textContent;
      b.textContent = 'Copied!';
      setTimeout(() => { b.textContent = old; }, 1500);
    });
  }

  function wireRosterRows(body, ctx) {
    const sid = ctx.schedule.id;
    body.querySelectorAll('[data-viewas]').forEach(btn => btn.addEventListener('click', () => {
      if (ML.tcSetViewAs) {
        ML.tcSetViewAs({
          scheduleId: sid,
          studentUid: btn.dataset.viewas,
          studentName: btn.dataset.name,
          status: btn.dataset.status || 'active'
        });
      }
      window.location.hash = '#/classes/' + sid;
    }));
    body.querySelectorAll('[data-panel-toggle]').forEach(btn => btn.addEventListener('click', () => {
      const row = btn.closest('.teach-student-row');
      const panel = row?.querySelector(`[data-panel="${btn.dataset.panelToggle}"]`);
      if (panel) panel.hidden = !panel.hidden;
    }));
    body.querySelectorAll('[data-remove]').forEach(btn => btn.addEventListener('click', () =>
      armConfirm(btn, async () => {
        try {
          await src().removeStudent(btn.dataset.remove);
          await ctx.refresh();
          setStatus('Student removed. They can re-join only with a live code.');
        } catch (e) { setStatus('Could not remove: ' + e.message, true); }
      })));
  }

  /* ================================================================
     TAB 3 — MODULES (what students get · the library, grouped by course)
     ----------------------------------------------------------------
     Alex (V3.771): "I dont want all the modules layed out like that.
     instead lets have cards that cluster the modules by group. click on
     a card and it opens up with a list of the available modules. No due
     date, No visibility, keep preview. make a button for 'make
     available'. At the top of the page is a selected list of learning
     modules that will be available to the students."

     So this tab is two things and nothing else: the list you have chosen
     (top) and the library you choose from (below, one card per course).
     Due dates, per-module visibility and coursework/grading are gone —
     how a teacher assigns and grades is their business, not ours.
     ================================================================ */

  // A preview shows the SAME static file the students open, but it is not
  // the class module-viewer route, so the V3.672 engagement beacon never
  // fires here — previewing a module records nothing.
  //
  // The <iframe> is BUILT ON FIRST OPEN, not rendered with the row: the
  // library runs to ~70 modules, and 70 dormant sandboxed iframes cost a
  // heavy DOM plus two console warnings each for a preview nobody opened.
  function previewHTML(folder, file) {
    const url = `modules/${encodeURIComponent(folder || '')}/${encodeURIComponent(file || '')}`;
    return `<div class="teach-preview" data-preview-url="${esc(url)}" hidden></div>`;
  }

  function openPreview(box) {
    if (box.dataset.built) return;
    box.dataset.built = '1';
    const url = box.dataset.previewUrl;
    box.innerHTML = `
      <div class="teach-preview-bar">
        <span class="tc-muted">Preview — exactly what your students see. Nothing is recorded.</span>
        <a class="btn btn-secondary btn-small" href="${esc(url)}" target="_blank" rel="noopener">Open in a new tab ↗</a>
        <button class="btn btn-secondary btn-small" data-preview-close>Close</button>
      </div>
      <iframe class="teach-preview-frame" src="${esc(url)}" title="Module preview"
        sandbox="allow-scripts allow-same-origin allow-popups allow-forms"></iframe>`;
    box.querySelector('[data-preview-close]').addEventListener('click', () => {
      box.hidden = true;
      const toggle = box.closest('[data-previewable]')?.querySelector('[data-preview-toggle]');
      if (toggle) toggle.textContent = 'Preview';
    });
  }

  function wirePreviews(scope) {
    scope.querySelectorAll('[data-preview-toggle]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const box = btn.closest('[data-previewable]')?.querySelector('.teach-preview');
        if (!box) return;
        openPreview(box);
        box.hidden = !box.hidden;
        btn.textContent = box.hidden ? 'Preview' : 'Hide preview';
        if (!box.hidden) box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
    });
  }

  /* ---------------- worksheets belong to their lesson ----------------
     Alex: "Worksheets should go along with learning modules not be
     separate items." `worksheet-03-…` (and `hw-03-…`, `hw3-…`) belongs
     to the lesson numbered 03 in the SAME folder — matching on the
     number, not the slug, because the two rarely agree
     (worksheet-01-surface-energy ↔ 01-surface-energy-and-adsorbed-water).
     A worksheet whose lesson is not in the list stays an item of its own
     (bme466's hw-00-pretest has no lesson 00). Pairing is presentation
     only: both still go into schedules.modules[] as ordinary entries, so
     students open a worksheet exactly as before. ------------------- */
  function baseName(file) { return String(file || '').replace(/\.html$/i, ''); }
  function pad2(n) { return String(Number(n)).padStart(2, '0'); }
  function lessonNum(file) {
    const m = /^(\d{1,2})[-_]/.exec(baseName(file));
    return m ? pad2(m[1]) : null;
  }
  function worksheetNum(file) {
    const m = /^(?:worksheets?|hw|homework)[-_ ]?(\d{1,2})(?:[-_. ]|$)/i.exec(baseName(file));
    return m ? pad2(m[1]) : null;
  }

  // Normalized item shapes — one grouping function serves both the
  // catalog (file/description) and schedules.modules[] (htmlFile).
  const catItem = (c) => ({
    id: c.id, folder: c.folder, file: c.file, title: c.title || c.file,
    desc: c.description || '',
    tags: [...(c.subjects || []), ...(c.gradeLevels || [])].join(' · ')
  });
  const modItem = (m) => ({
    id: m.id, folder: m.folder, file: m.htmlFile, title: m.title || m.htmlFile, desc: '', tags: ''
  });
  // Every saved entry is rebuilt from the normalized item, which is also
  // how V3.769's dueDate / published:false fields drain away: the fields
  // no longer exist in the UI, so they stop existing in the data on the
  // next save rather than lingering invisibly.
  const entryOf = (x) => ({
    id: x.id, folder: x.folder, htmlFile: x.file, title: x.title, published: true
  });

  function withWorksheets(items) {
    const lessonAt = new Map();
    for (const it of items) {
      if (worksheetNum(it.file)) continue;
      const n = lessonNum(it.file);
      if (n) lessonAt.set(it.folder + '/' + n, it);
    }
    const parentOf = (it) => {
      const wn = worksheetNum(it.file);
      const p = wn ? lessonAt.get(it.folder + '/' + wn) : null;
      return p && p !== it ? p : null;
    };
    const nodes = [], byItem = new Map();
    for (const it of items) {
      if (parentOf(it)) continue;
      const node = { item: it, sheets: [] };
      byItem.set(it, node);
      nodes.push(node);
    }
    for (const it of items) {
      const p = parentOf(it);
      if (p && byItem.has(p)) byItem.get(p).sheets.push(it);
    }
    return nodes;
  }

  // Which library card is open, kept out here so it survives the
  // re-render that follows every add/remove.
  let openLibFolder = null;

  async function renderModulesTab(body, ctx) {
    const { schedule, hub } = ctx;
    let catalog = [];
    let catalogErr = null;
    try { catalog = await src().publishedCatalog(); }
    catch (e) { catalogErr = e; console.warn('[TEACH] catalog', e); }
    const folders = await (ML.tcManifestFolders ? ML.tcManifestFolders().catch(() => ({})) : {});
    const labelOf = (f) => folders[f]?.label || f;

    const chosenNodes = withWorksheets(hub.modules.map(modItem));
    const chosenIds = new Set(hub.modules.map(m => m.id));

    const byFolder = new Map();
    for (const c of catalog.map(catItem)) {
      if (!byFolder.has(c.folder)) byFolder.set(c.folder, []);
      byFolder.get(c.folder).push(c);
    }
    const groups = [...byFolder.entries()]
      .map(([folder, items]) => {
        const nodes = withWorksheets(items);
        return {
          folder, label: labelOf(folder), nodes,
          added: nodes.filter(n => chosenIds.has(n.item.id)).length
        };
      })
      .sort((a, b) => a.label.localeCompare(b.label));
    if (openLibFolder && !groups.some(g => g.folder === openLibFolder)) openLibFolder = null;

    const sheetRow = (s, cls) => `
      <div class="${cls}" data-previewable>
        <span class="teach-sheet-title">${ICON.svg('document-text')} ${esc(s.title)}</span>
        <button class="btn btn-secondary btn-small" data-preview-toggle>Preview</button>
        ${previewHTML(s.folder, s.file)}
      </div>`;

    body.innerHTML = `
      <div class="dash-card">
        <h3>Module library</h3>
        <p class="tc-muted">Everything the lab has published for teachers, grouped by course. Open a
          course to see its lessons, preview any of them — the preview is the real lesson,
          simulations and all — and make the ones you want available to your class.</p>
        ${catalogErr ? `<p class="error-text">Could not load the module library: ${esc(catalogErr.message || catalogErr)}</p>` : ''}
        ${!catalogErr && !groups.length ? `<p class="tc-muted">The lab hasn’t published any modules
          for teachers yet — check back soon.</p>` : ''}
        ${groups.length ? `
        <div class="teach-lib-grid">
          ${groups.map(g => {
            const open = g.folder === openLibFolder;
            return `
            <div class="teach-lib-card${open ? ' open' : ''}" data-folder="${esc(g.folder)}">
              <button class="teach-lib-head" data-lib-toggle aria-expanded="${open ? 'true' : 'false'}">
                <span class="teach-lib-caret">${open ? '▾' : '▸'}</span>
                <span class="teach-lib-name">${esc(g.label)}</span>
                <span class="teach-lib-count">${g.added
                  ? `${g.added} of ${g.nodes.length} available`
                  : plural(g.nodes.length, 'lesson')}</span>
              </button>
              <div class="teach-lib-body"${open ? '' : ' hidden'}>
                ${g.nodes.map(n => {
                  const on = chosenIds.has(n.item.id);
                  return `
                  <div class="teach-lib-row${on ? ' on' : ''}" data-previewable data-mod="${esc(n.item.id)}">
                    <span class="teach-lib-row-main">
                      <span class="teach-lib-title">${esc(n.item.title)}</span>
                      ${n.item.tags ? `<span class="tc-muted">${esc(n.item.tags)}</span>` : ''}
                      ${n.item.desc ? `<span class="teach-lib-desc tc-muted">${esc(n.item.desc)}</span>` : ''}
                      ${n.sheets.length ? `<span class="tc-muted">comes with ${esc(plural(n.sheets.length, 'worksheet'))}</span>` : ''}
                    </span>
                    <span class="teach-lib-actions">
                      <button class="btn btn-secondary btn-small" data-preview-toggle>Preview</button>
                      ${on
                        ? `<span class="tc-chip tc-chip-approved">✓ Available</span>
                           <button class="btn btn-secondary btn-small" data-drop-id="${esc(n.item.id)}">Remove</button>`
                        : `<button class="btn btn-primary btn-small" data-add="${esc(n.item.id)}">Make available</button>`}
                    </span>
                    ${previewHTML(n.item.folder, n.item.file)}
                    ${n.sheets.length ? `<div class="teach-sheets">
                      ${n.sheets.map(s => sheetRow(s, 'teach-sheet-row')).join('')}
                    </div>` : ''}
                  </div>`;
                }).join('')}
              </div>
            </div>`;
          }).join('')}
        </div>` : ''}
      </div>

      <div class="dash-card">
        <h3>Available to your students (${chosenNodes.length})</h3>
        <p class="tc-muted">This is the class page your students see, in this order. Any worksheets
          come with their lesson. Add or drop lessons from the library above at any time.</p>
        ${chosenNodes.length ? `
        <div class="teach-pick-list">
          ${chosenNodes.map((n, i) => `
          <div class="teach-pick-row" data-node="${i}" data-previewable>
            <span class="teach-pick-n">${i + 1}</span>
            <span class="teach-pick-main">
              <span class="teach-pick-title">${esc(n.item.title)}</span>
              <span class="tc-muted">${esc(labelOf(n.item.folder))}</span>
            </span>
            <span class="teach-pick-actions">
              <button class="teach-arrow" data-move-up="${i}" ${i === 0 ? 'disabled' : ''} aria-label="Move up">▲</button>
              <button class="teach-arrow" data-move-down="${i}" ${i === chosenNodes.length - 1 ? 'disabled' : ''} aria-label="Move down">▼</button>
              <button class="btn btn-secondary btn-small" data-preview-toggle>Preview</button>
              <button class="btn btn-secondary btn-small" data-drop="${i}">Remove</button>
            </span>
            ${previewHTML(n.item.folder, n.item.file)}
            ${n.sheets.length ? `<div class="teach-sheets">
              ${n.sheets.map(s => sheetRow(s, 'teach-sheet-row')).join('')}
            </div>` : ''}
          </div>`).join('')}
        </div>` : `<p class="tc-muted">Nothing yet — your class starts empty. Open a course above,
          preview a lesson, and press <strong>Make available</strong>; what you pick shows up here,
          and here is exactly what your students get.</p>`}
      </div>`;

    wirePreviews(body);
    wireModulePicks(body, ctx, chosenNodes, groups);
  }

  function wireModulePicks(body, ctx, chosenNodes, groups) {
    const sid = ctx.schedule.id;

    // One save path: nodes → a flat modules[] with each lesson followed by
    // its worksheets, renumbered. Order, add and remove all go through it.
    async function saveNodes(nodes, okMsg) {
      const next = [];
      nodes.forEach(n => {
        next.push(entryOf(n.item));
        n.sheets.forEach(s => next.push(entryOf(s)));
      });
      next.forEach((m, i) => { m.order = i; });
      try {
        await src().saveClassModules(sid, next);
        // AFTER the refresh, never before: ctx.refresh() rebuilds the shell
        // (#teach-status included), so a message set first is thrown away
        // before anyone reads it.
        await ctx.refresh();
        setStatus(okMsg || 'Saved.');
      } catch (e) { setStatus('Could not save: ' + e.message, true); }
    }
    const libNode = (id) => {
      for (const g of groups) {
        const n = g.nodes.find(x => x.item.id === id);
        if (n) return n;
      }
      return null;
    };
    const dropAt = (i, title) => {
      const next = chosenNodes.slice();
      next.splice(i, 1);
      saveNodes(next, `“${title}” is no longer available to your students.`);
    };

    body.querySelectorAll('[data-move-up]').forEach(btn => btn.addEventListener('click', () => {
      const i = Number(btn.dataset.moveUp);
      const next = chosenNodes.slice();
      [next[i - 1], next[i]] = [next[i], next[i - 1]];
      saveNodes(next, 'Order updated.');
    }));
    body.querySelectorAll('[data-move-down]').forEach(btn => btn.addEventListener('click', () => {
      const i = Number(btn.dataset.moveDown);
      const next = chosenNodes.slice();
      [next[i], next[i + 1]] = [next[i + 1], next[i]];
      saveNodes(next, 'Order updated.');
    }));
    body.querySelectorAll('[data-drop]').forEach(btn => btn.addEventListener('click', () =>
      armConfirm(btn, () => {
        const i = Number(btn.dataset.drop);
        dropAt(i, chosenNodes[i]?.item.title || 'Module');
      })));
    body.querySelectorAll('[data-drop-id]').forEach(btn => btn.addEventListener('click', (e) => {
      e.stopPropagation();
      armConfirm(btn, () => {
        const i = chosenNodes.findIndex(n => n.item.id === btn.dataset.dropId);
        if (i >= 0) dropAt(i, chosenNodes[i].item.title);
      });
    }));
    body.querySelectorAll('[data-add]').forEach(btn => btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const node = libNode(btn.dataset.add);
      if (!node) return;
      btn.disabled = true;
      saveNodes(chosenNodes.concat([{ item: node.item, sheets: node.sheets.slice() }]),
        `“${node.item.title}” is now available to your students${
          node.sheets.length ? ', with its ' + noun(node.sheets.length, 'worksheet') : ''}.`);
    }));

    // One course open at a time: the cards are a grid, and the open one
    // spans it, so two open cards read as one confusing block.
    body.querySelectorAll('[data-lib-toggle]').forEach(btn => btn.addEventListener('click', () => {
      const card = btn.closest('.teach-lib-card');
      const wasOpen = card.classList.contains('open');
      body.querySelectorAll('.teach-lib-card').forEach(c => {
        c.classList.remove('open');
        c.querySelector('.teach-lib-body').hidden = true;
        c.querySelector('[data-lib-toggle]').setAttribute('aria-expanded', 'false');
        c.querySelector('.teach-lib-caret').textContent = '▸';
      });
      if (wasOpen) { openLibFolder = null; return; }
      card.classList.add('open');
      card.querySelector('.teach-lib-body').hidden = false;
      btn.setAttribute('aria-expanded', 'true');
      card.querySelector('.teach-lib-caret').textContent = '▾';
      openLibFolder = card.dataset.folder;
      card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }));
  }

  /* ================================================================
     TAB 4 — ENGAGEMENT (classroom availability for outreach visits)
     ----------------------------------------------------------------
     The teacher side of the hub is MOUNTED from engage-hub.js rather
     than rebuilt here, so the public #/engage page and this tab are
     the same code and can never drift.
     ================================================================ */
  async function renderEngagementTab(body, ctx) {
    const { schedule, hub } = ctx;
    // V3.784 — the panel below is now seven step cards, so this intro only
    // says what the tab is for and how the steps split. The old "See the
    // public hub" link is gone: #/engage shows a teacher this same panel,
    // not the researchers' view, so it led back to where they already were.
    body.innerHTML = `
      <div class="dash-card teach-engage-intro">
        <h3>Scientists in your classroom</h3>
        <p class="tc-muted">University researchers can visit your class for a guest talk, a hands-on
          demo, a lab tour or a career chat. Steps 1–5 list your class and only need doing once. After
          that you post when your class is free and say yes or no to requests. Your school's address
          is only shared with a visit you confirm.</p>
      </div>
      <div id="teach-engage-panel"><p class="loading-text">Loading your availability…</p></div>`;

    const panel = document.getElementById('teach-engage-panel');
    if (!ML.mountEngageTeacherPanel) {
      panel.innerHTML = `<div class="dash-card"><p class="error-text">
        The engagement hub didn't load — refresh the page.</p></div>`;
      return;
    }
    await ML.mountEngageTeacherPanel(panel, {
      embedded: true,
      // The slot form pre-fills its class context from the class you are
      // managing, which is what makes "expected students / student level"
      // one click instead of retyping per slot.
      // V3.784 — no `subject`: schedule.subtitle is the SCHOOL (the approve
      // modal and redeemTeacherInvite both write it), so it had been
      // pre-filling every new time's Subject with the school name.
      classHint: {
        title: schedule.title || '',
        size: hub.active.length || null
      },
      onChange: () => ctx.refresh()
    });
  }

  /* ================================================================
     FOR-TEACHERS LANDING — #/teachers (V3.680)
     ----------------------------------------------------------------
     The single front door for teacher onboarding, linked from the
     Classes page. Teacher-focused with NO student surfaces: program
     pitch, Google sign-in, the class-request form + request status,
     and redemption of an admin-issued invite link
     (#/teachers?invite=TOKEN → redeemTeacherInvite Cloud Function
     provisions the class + join code + category:'teacher' directly,
     no approval round-trip).
     ================================================================ */
  const INVITE_FN_URL = 'https://us-central1-mcgheelab-f56cc.cloudfunctions.net/redeemTeacherInvite';

  function inviteTokenFromHash() {
    const qs = new URLSearchParams((window.location.hash.split('?')[1]) || '');
    return (qs.get('invite') || '').trim();
  }

  function renderTeachersLanding() {
    return `<div class="dashboard-page teach-page" id="teachers-root">
      <p class="loading-text">Loading…</p>
    </div>`;
  }

  function teachersPitchHTML() {
    return `
      <div class="dash-card">
        <h3>Bring our interactive modules to your classroom</h3>
        <p>The McGhee Lab builds free, browser-based science modules — optics, solid
          mechanics, biomechanics, bioprinting, and more — with live simulations built for
          classroom teaching. As a partner teacher you get:</p>
        <ul class="teachers-pitch-list">
          <li><strong>Your own class page</strong> with a join code your students use — no
            installs, works on Chromebooks.</li>
          <li><strong>A teaching dashboard</strong>: pick modules from our catalog, set the
            order and due dates, give assignments, and grade responses.</li>
          <li><strong>Engagement at a glance</strong>: who opened what, real time-on-lesson,
            and who's gone quiet.</li>
          <li><strong>Scientists in your classroom</strong>: post availability on our
            engagement hub and university researchers request visits — talks, demos, career
            chats.</li>
        </ul>
        <p class="tc-muted">Free for schools. The lab reviews every request.</p>
      </div>`;
  }

  async function wireTeachersLanding() {
    const root = document.getElementById('teachers-root');
    if (!root) return;
    await waitForAuth();

    const token = inviteTokenFromHash();
    const signedIn = demo() ? !demo().signedOut : !!ML.Auth?.currentUser;
    const p = myProfile();

    let body = `<div class="dash-header"><h2>For Teachers</h2></div>
      <div id="teach-status" class="teach-status" hidden></div>
      ${teachersPitchHTML()}`;

    // V3.808 — the low-friction door: a teacher who only wants a scientist
    // to visit doesn't need an account at all (engage-guest.js). Shown to
    // everyone but a set-up teacher, who posts from their Engagement tab.
    if (p.category !== 'teacher' || !signedIn) {
      body += `
      <div class="dash-card teachers-noaccount">
        <h3>Just want a scientist to visit your class?</h3>
        <p>Post a guest talk, demo, lab tour or career chat with the dates that work for you.
          <strong>No account and no sign-in</strong>: you get a private link to see who signs up and accept a presenter.</p>
        <p><a class="btn btn-primary" href="#/invite-a-scientist">Invite a scientist &rarr;</a></p>
      </div>`;
    }

    if (token) {
      body += `
      <div class="dash-card teach-invite-card" id="teachers-invite">
        <h3>You've been invited ${ICON.svg('sparkles')}</h3>
        <p>The McGhee Lab set aside a class for you. ${signedIn
          ? 'One click creates your class page and join code.'
          : 'Sign in with Google (any Google account works — school or personal) and we’ll set it up.'}</p>
        ${signedIn
          ? `<p><button class="btn btn-primary" id="teachers-redeem">Set up my class</button></p>`
          : `<p><button class="btn btn-primary" id="teachers-signin">Sign in with Google</button></p>`}
        <div id="teachers-invite-status" class="form-status" hidden></div>
      </div>`;
    }

    if (!signedIn) {
      if (!token) {
        body += `
        <div class="dash-card">
          <h3>Request a class</h3>
          <p class="tc-muted">Sign in with Google (any account — school or personal), tell us
            about your class, and we'll review your request.</p>
          <p><button class="btn btn-primary" id="teachers-signin">Sign in with Google</button></p>
          <div id="teachers-signin-status" class="form-status" hidden></div>
        </div>`;
      }
      root.innerHTML = body;
      document.getElementById('teachers-signin')?.addEventListener('click', async () => {
        if (demo()) { demo().note('Google sign-in is disabled in demo preview.'); return; }
        const st = document.getElementById('teachers-invite-status') ||
                   document.getElementById('teachers-signin-status');
        try {
          await ML.Auth.googleLogin();
          await wireTeachersLanding();
        } catch (e) {
          if (st) { st.textContent = 'Sign-in failed: ' + e.message; st.className = 'form-status error'; st.hidden = false; }
        }
      });
      return;
    }

    // Signed in — existing teachers get their dashboard link; everyone gets
    // the request form + their request history.
    if (p.category === 'teacher') {
      body += `
      <div class="dash-card">
        <h3>You're set up</h3>
        <p><a class="btn btn-primary" href="#/teach">Open your teaching dashboard &rarr;</a>
           <a class="btn btn-secondary" href="#/engage">Engagement hub</a></p>
        <p class="tc-muted">Want to run another class? Request it below.</p>
      </div>`;
    }
    body += `<div class="dash-card" id="teachers-request-card"><h3>Request a class</h3>
      <p class="tc-muted">Loading…</p></div>`;
    root.innerHTML = body;
    wireInviteRedeem(token);
    await loadTeachersRequestCard();
  }

  function wireInviteRedeem(token) {
    const btn = document.getElementById('teachers-redeem');
    if (!btn || !token) return;
    btn.addEventListener('click', async () => {
      const st = document.getElementById('teachers-invite-status');
      const say = (msg, err) => { st.textContent = msg; st.className = 'form-status' + (err ? ' error' : ' success'); st.hidden = false; };
      if (demo()) { demo().note('Invite redemption is disabled in demo preview.'); return; }
      btn.disabled = true;
      say('Setting up your class…');
      try {
        const idToken = await ML.Auth.currentUser.getIdToken();
        const res = await fetch(INVITE_FN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + idToken },
          body: JSON.stringify({ token })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
        // Category just flipped server-side — refresh the local profile so the
        // teacher surfaces render without a reload.
        try { ML.Auth.currentProfile = await ML.DB.getUser(ML.Auth.currentUser.uid); } catch (e) {}
        const card = document.getElementById('teachers-invite');
        if (card) card.innerHTML = `
          <h3>Your class is ready ${ICON.svg('sparkles')}</h3>
          <p><strong>${esc(data.classTitle || 'Your class')}</strong></p>
          <p>Join code for your students:
            <span class="tc-code">${esc(data.joinCode || '')}</span>
            <button class="btn btn-secondary btn-small" data-copy-code="${esc(data.joinCode || '')}">Copy</button></p>
          <p class="tc-muted">Share your class link
            <a href="#/classes/${esc(data.scheduleId || '')}">mcgheelab.com/#/classes/${esc(data.scheduleId || '')}</a>
            with your students along with the code.</p>
          <p><a class="btn btn-primary" href="#/teach/${esc(data.scheduleId || '')}">Open your class &rarr;</a></p>`;
        wireCopyButtons(card || document);
      } catch (e) {
        btn.disabled = false;
        say('Could not set up the class: ' + e.message, true);
      }
    });
  }

  // V3.792 — the request form offers only the module sets the lab has
  // actually published (teacherCatalog rows with published:true — the same
  // subset the Modules tab shows an approved teacher). Before this it listed
  // every manifest folder, so applicants ticked courses nobody could get.
  // Folders the manifest no longer knows are dropped; if the manifest itself
  // failed to load, the catalog's folder keys stand in as labels.
  function requestFolderOptions(folders, catalog) {
    const counts = new Map();
    for (const c of catalog || []) {
      if (!c || !c.folder || c.published === false) continue;
      counts.set(c.folder, (counts.get(c.folder) || 0) + 1);
    }
    const known = Object.keys(folders || {});
    return [...counts.keys()]
      .filter(k => !known.length || known.includes(k))
      .map(k => ({ key: k, label: (folders && folders[k] && folders[k].label) || k, count: counts.get(k) }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }

  async function loadTeachersRequestCard() {
    const el = document.getElementById('teachers-request-card');
    if (!el) return;
    const uid = me();
    const [requests, folders, catalog] = await Promise.all([
      src().myRequests(uid).catch(() => []),
      (ML.tcManifestFolders ? ML.tcManifestFolders() : Promise.resolve({})).catch(() => ({})),
      (src().publishedCatalog ? src().publishedCatalog() : Promise.resolve([])).catch(() => [])
    ]);
    const hasPending = requests.some(r => r.status === 'pending');
    const folderOptions = requestFolderOptions(folders, catalog);

    let html = '<h3>Request a class</h3>';
    if (requests.length) {
      html += requests.map(r => `
        <div class="eh-req-row" data-request="${esc(r.id)}">
          <span class="tc-chip ${r.status === 'approved' ? 'tc-chip-approved' : r.status === 'pending' ? 'tc-chip-pending' : 'tc-chip-denied'}">${esc(r.status)}</span>
          <span>${esc(r.school || '')}${r.subjectArea ? ' — ' + esc(r.subjectArea) : ''}</span>
          ${r.status === 'denied' && r.denyReason ? `<p class="tc-muted">Reason: ${esc(r.denyReason)}</p>` : ''}
          ${r.status === 'approved' ? '<p class="tc-muted">Approved — find it on <a href="#/teach">your teaching dashboard</a>.</p>' : ''}
          ${r.status === 'pending' ? '<button class="btn btn-secondary btn-small" data-withdraw>Withdraw</button>' : ''}
        </div>`).join('');
    }
    if (hasPending) {
      html += '<p class="tc-muted">Your request is being reviewed — we’ll notify you and your class will appear on your teaching dashboard once it’s approved.</p>';
    } else {
      html += `
      <form id="teachers-request-form">
        <div class="teach-af-row">
          <label>School <input type="text" data-tr-school required placeholder="School name"></label>
          <label>City <input type="text" data-tr-city></label>
          <label>State <input type="text" data-tr-state></label>
        </div>
        <div class="teach-af-row">
          <label>Grade level <input type="text" data-tr-grade placeholder="e.g. 11–12"></label>
          <label>Class size <input type="number" data-tr-size min="1" max="500" placeholder="e.g. 28"></label>
          <label>Subject <input type="text" data-tr-subject placeholder="e.g. AP Biology"></label>
        </div>
        ${folderOptions.length ? `
        <div class="form-group"><label>Module sets you're interested in</label>
          <div class="tc-folder-list">
            ${folderOptions.map(o => `
              <label class="tc-folder-option">
                <input type="checkbox" value="${esc(o.key)}"> ${esc(o.label)}
                <span class="tc-muted">(${o.count} ${o.count === 1 ? 'module' : 'modules'})</span>
              </label>`).join('')}
          </div>
        </div>` : ''}
        <div class="form-group"><label>Anything else?</label>
          <textarea data-tr-message rows="3" placeholder="Timeline, goals, questions…"></textarea></div>
        <p><button type="submit" class="btn btn-primary">Submit request</button></p>
      </form>`;
    }
    el.innerHTML = html;

    el.querySelectorAll('[data-withdraw]').forEach(btn => btn.addEventListener('click', () =>
      armConfirm(btn, async () => {
        try {
          await src().withdrawRequest(btn.closest('[data-request]').dataset.request);
          setStatus('Request withdrawn.');
          await loadTeachersRequestCard();
        } catch (e) { setStatus('Could not withdraw: ' + e.message, true); }
      })));
    document.getElementById('teachers-request-form')?.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const f = ev.target;
      const school = f.querySelector('[data-tr-school]').value.trim();
      if (!school) { setStatus('Tell us your school.', true); return; }
      const p = myProfile();
      try {
        await src().createRequest({
          teacherUid: me(),
          teacherName: p.name || ML.Auth?.currentUser?.displayName || '',
          teacherEmail: p.email || ML.Auth?.currentUser?.email || '',
          school,
          schoolCity: f.querySelector('[data-tr-city]').value.trim(),
          schoolState: f.querySelector('[data-tr-state]').value.trim(),
          gradeLevel: f.querySelector('[data-tr-grade]').value.trim(),
          classSize: Number(f.querySelector('[data-tr-size]').value) || null,
          subjectArea: f.querySelector('[data-tr-subject]').value.trim(),
          requestedFolders: [...f.querySelectorAll('.tc-folder-option input:checked')].map(i => i.value),
          message: f.querySelector('[data-tr-message]').value.trim(),
          status: 'pending'
        });
        setStatus('Request sent — the lab reviews every request.');
        await loadTeachersRequestCard();
      } catch (e) { setStatus('Could not submit: ' + e.message, true); }
    });
  }

  /* ================================================================
     EXPORTS
     ================================================================ */
  ML.renderTeachPage = renderTeachPage;
  ML.wireTeachPage = wireTeachPage;
  ML.renderTeachersLanding = renderTeachersLanding;
  ML.wireTeachersLanding = wireTeachersLanding;
  ML.tcRequestFolderOptions = requestFolderOptions; // V3.792 — pure; exposed so it can be tested without a browser
})();
