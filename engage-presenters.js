/* ================================================================
   PRESENTER PAGE — #/presenters (V3.785)
   ----------------------------------------------------------------
   The outside half of the classroom engagement hub. Alex: "a page that
   is public but not in the site navigation so people must have a link
   to view", for people signing up to present to high-school and
   community-college classes.

   • Link-only. Nothing in the site links here; admin copies the link
     from rm/pages/admin-teachers.html?tab=engage. Anyone who opens it
     and signs in with Google can browse and request (the link IS the
     gate — rules no longer need the engage:browse/request caps). Each
     teacher still vets by accepting or declining, and admin can block
     a presenter (engagePresenters/{uid}.blocked, enforced by rules).

   • First visit: "About you" (engagePresenters/{uid}), denormalised onto
     every request so the teacher sees who is asking.

   • Your visits: review due (a confirmed visit that has happened and has
     no review) → pending → coming up (the address the teacher shared,
     expected students) → past.

   • Find a classroom (V3.791 — opportunity-centred): every approved
     school's OPPORTUNITIES — one thing a teacher would like, with the dates
     that would work — filtered by school, kind of school, activity, format,
     day, time of day and date range, as a List of cards or a Calendar.
     Signing up = ticking the dates you could do; the teacher picks one when
     accepting, and the opportunity leaves the list. A sign-up someone else
     has made shows as "pending acceptance" (the count comes from
     engageOpportunities.pendingCount, kept by functions/engage-notify.js,
     because nobody can read anyone else's request). The filter bar is
     STATIC markup wired once and only the results re-render, so the search
     box never loses focus mid-word (the V3.770 lesson).

   • Reviews (engageReviews/{requestId}) are read ONLY by query — a get of
     a review that doesn't exist yet is denied by the rules (V3.772).

   Rendering helpers come from engage-hub.js's ML.EngageKit so a listing
   reads the same here as in the teacher's own step-5 preview. Data rides
   TC_DB and the demo seam (#/demo "Presenter" personas).

   Loaded after engage-hub.js, before teacher-demo.js.
   ================================================================ */
(function () {
  'use strict';

  const ML = window.McgheeLab = window.McgheeLab || {};
  const K = () => ML.EngageKit;

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

  const HORIZON_DAYS = 120;           // how far ahead a presenter can look
  const DEFAULT_SPAN = 56;            // default date range: the next 8 weeks
  const LIST_CAP = 80;
  const TOD = [['morning', 'Morning'], ['afternoon', 'Afternoon'], ['evening', 'Evening']];
  const todOf = (t) => { const h = parseInt(String(t || '').slice(0, 2), 10);
    return isNaN(h) ? '' : h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening'; };
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  // View state lives outside the render so a reload (a request sent, a
  // review saved) keeps the teacher's filters, view and month.
  // V3.788 — the calendar is the page: it opens on Calendar, and List is the
  // alternative.
  const view = { mode: 'calendar', month: null, day: null, openKey: null, editAbout: false, reviewing: null, f: null, moreOpen: null };
  function freshFilters() {
    const k = K();
    return { q: '', school: '', types: new Set(), acts: new Set(), fmts: new Set(),
      days: new Set(), tods: new Set(), from: k.todayISO(), to: k.addDays(k.todayISO(), DEFAULT_SPAN - 1) };
  }

  function setStatus(msg, isErr, where) {
    const el = (where && document.getElementById(where)) || document.getElementById('ep-status');
    if (!el) return;
    el.textContent = msg || '';
    el.className = 'teach-status' + (isErr ? ' error-text' : '');
    el.hidden = !msg;
    clearTimeout(setStatus._t);
    if (msg && !isErr) setStatus._t = setTimeout(() => { el.hidden = true; }, 4000);
  }

  /* ================================================================
     SKELETON + DISPATCH
     ================================================================ */
  function renderPresentersPage() {
    return `<div class="dashboard-page teach-page ep-page" id="presenters-root">
      <p class="loading-text">Loading…</p>
    </div>`;
  }

  async function wirePresentersPage() {
    const root = document.getElementById('presenters-root');
    if (!root || !K()) return;
    await waitForAuth();
    const signedIn = demo() ? !demo().signedOut : !!ML.Auth?.currentUser;
    if (!signedIn) { renderSignedOut(root); return; }
    // The popup-blocked redirect fallback left this set; we are here now.
    try {
      if (sessionStorage.getItem('mcghee_login_redirect') === '#/presenters') {
        sessionStorage.removeItem('mcghee_login_redirect');
      }
    } catch (e) { /* private mode */ }
    // V3.788 — nobody is turned away. A teacher can present too; the page
    // only adds a one-line pointer to their own dashboard (see paint()) and
    // leaves their own class out of the openings. (V3.785 showed a teacher a
    // "this page is for presenters" card and nothing else, which is what an
    // account wrongly marked category:'teacher' ran into.)
    if (!view.f) view.f = freshFilters();
    try { await load(root); }
    catch (e) {
      console.warn('[PRESENTERS]', e);
      root.innerHTML = `<div class="dash-card"><h3>Visit a classroom</h3>
        <p class="error-text">Failed to load: ${K().esc(e.message || e)}</p></div>`;
    }
  }

  function renderSignedOut(root) {
    root.innerHTML = `
      <div class="dash-header"><h2>Visit a classroom</h2></div>
      <div class="dash-card ep-pitch">
        <h3>Share your work with a high-school or community-college class</h3>
        <p>Teachers who use the McGhee Lab's interactive science modules open their classrooms to
          guest talks, hands-on demos, lab tours and career chats. Sign in to see when their classes
          are free, narrow it down by school and time, and ask for a date.</p>
        <ol class="ep-how">
          <li><strong>Sign in</strong> and tell teachers who you are.</li>
          <li><strong>Pick an opening</strong> from any school's calendar.</li>
          <li><strong>The teacher accepts</strong> and emails you when, where and how many students to expect.</li>
          <li><strong>After the visit</strong>, leave a short review of how it went.</li>
        </ol>
        <p><button type="button" class="btn btn-primary" id="ep-signin">Sign in with Google</button>
          <span class="tc-muted">Any Google account works, university or personal.</span></p>
        <div id="ep-signin-status" class="form-status" hidden></div>
        <p class="tc-muted">Schools' street addresses are only shared with a presenter once the teacher
          accepts their visit.</p>
      </div>`;
    document.getElementById('ep-signin').addEventListener('click', async () => {
      if (demo()) { demo().note('Google sign-in is disabled in demo preview.'); return; }
      const st = document.getElementById('ep-signin-status');
      try {
        // googleLogin's popup-blocked fallback redirects; make it come back here.
        try { sessionStorage.setItem('mcghee_login_redirect', '#/presenters'); } catch (e) {}
        await ML.Auth.googleLogin();
        await wirePresentersPage();
      } catch (e) {
        st.textContent = 'Sign-in failed: ' + e.message;
        st.className = 'form-status error'; st.hidden = false;
      }
    });
  }

  /* ================================================================
     LOAD + PAINT
     ================================================================ */
  let S = null;
  async function load(root) {
    const uid = me();
    const [presenter, profiles, opps, mine, reviews] = await Promise.all([
      src().getPresenter(uid).catch(() => null),
      src().approvedEngageProfiles(),
      src().openOpportunities(),
      src().engageRequestsForRequester(uid).catch(() => []),
      src().reviewsForRequester(uid).catch(() => [])
    ]);
    // A teacher presenting elsewhere doesn't need their own class offered back.
    const others = profiles.filter(p => (p.teacherUid || p.id) !== uid);
    const listed = new Map(others.map(p => [p.teacherUid || p.id, p]));
    S = {
      uid, presenter, profiles: others, isTeacher: myProfile().category === 'teacher',
      // An opportunity counts only if its teacher's listing is approved (the
      // rules refuse a request to anything else) and a date is still ahead.
      opps: opps.filter(o => listed.has(o.teacherUid) && K().oppNextDate(o)),
      listed, mine, reviewByReq: new Map(reviews.map(r => [r.id, r])),
      // My live sign-up per opportunity, so a card can say "you signed up".
      mineByOpp: new Map(mine.filter(r => r.status === 'pending' || r.status === 'confirmed').map(r => [r.opportunityId, r]))
    };
    paint(root);
  }

  function paint(root) {
    const k = K();
    const esc = k.esc;
    const blocked = !!S.presenter?.blocked;
    const today = k.todayISO();
    const due = S.mine.filter(r => r.status === 'confirmed' && String(r.date) < today && !S.reviewByReq.has(r.id)).length;
    root.innerHTML = `
      <div class="dash-header"><h2>Visit a classroom</h2></div>
      <p class="tc-muted ep-intro">Every opportunity at every listed school: what a teacher would like, and the
        dates that would work. Sign up and tick the dates you could do; the teacher picks one, accepts, and emails you
        the details.</p>
      <div id="ep-status" class="teach-status" hidden></div>
      ${blocked ? `<div class="dash-card"><p class="error-text">Your presenter access is paused. If you think
        that's a mistake, contact the McGhee Lab.</p></div>` : ''}
      ${S.isTeacher ? `<p class="ep-me ep-teacher-note"><span>You teach a class too. Its own availability and
        requests are on your teaching dashboard.</span> <a class="btn btn-secondary btn-small" href="#/teach">Teaching dashboard &rarr;</a></p>` : ''}
      ${aboutHTML()}
      ${due ? `<p class="ep-me ep-due-note"><span><strong>${due === 1 ? 'A visit' : due + ' visits'}</strong> you made
        ${due === 1 ? 'is' : 'are'} waiting for a short review.</span>
        <button type="button" class="btn btn-primary btn-small" data-jump-visits>Write it</button></p>` : ''}
      <div class="dash-card ep-find" id="ep-find">
        <h3>Find a classroom</h3>
        <div id="ep-find-status" class="teach-status" hidden></div>
        ${toolbarHTML()}
        <div class="ep-summary" id="ep-summary" aria-live="polite"></div>
        <div id="ep-results"></div>
      </div>
      ${visitsHTML()}`;
    root.querySelector('[data-jump-visits]')?.addEventListener('click', () => {
      document.getElementById('ep-visits')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
    wireAbout(root);
    wireVisits(root);
    wireToolbar(root);
    renderResults(root);
  }

  /* ---- About you ---- */
  function aboutHTML() {
    const esc = K().esc;
    const pr = S.presenter;
    const p = myProfile();
    const v = pr || { name: p.name || ML.Auth?.currentUser?.displayName || '',
      email: p.email || ML.Auth?.currentUser?.email || '' };
    if (!pr && !view.editAbout) return `
      <div class="ep-me ep-about-prompt" id="ep-about">
        <span>Before you ask for a visit, tell teachers who you are. It takes a minute.</span>
        <button type="button" class="btn btn-primary btn-small" data-edit-about>Add your details</button>
      </div>`;
    if (pr && !view.editAbout) return `
      <div class="ep-me">
        <span><strong>${esc(pr.name)}</strong>${pr.title ? ' · ' + esc(pr.title) : ''} · ${esc(pr.affiliation || '')}
          <span class="tc-muted">${esc(pr.email || '')}</span></span>
        <button type="button" class="btn btn-secondary btn-small" data-edit-about>Edit your details</button>
      </div>`;
    return `
      <div class="dash-card ep-about" id="ep-about">
        <h3>${pr ? 'Your details' : 'First, tell teachers who you are'}</h3>
        <p class="tc-muted">Teachers see this with every request you send, and the email a teacher sends
          you goes to the address below.</p>
        <div id="ep-about-status" class="teach-status" hidden></div>
        <div class="eh-fields">
          <div class="form-group"><label for="ep-a-name">Your name</label>
            <input id="ep-a-name" type="text" data-a="name" value="${esc(v.name || '')}" autocomplete="name"></div>
          <div class="form-group"><label for="ep-a-aff">Where you work or study</label>
            <input id="ep-a-aff" type="text" data-a="affiliation" value="${esc(v.affiliation || '')}" placeholder="e.g. UofA Biomedical Engineering"></div>
          <div class="form-group"><label for="ep-a-title">Your role <span class="tc-muted">(optional)</span></label>
            <input id="ep-a-title" type="text" data-a="title" value="${esc(v.title || '')}" placeholder="e.g. PhD student, Professor, Engineer"></div>
          <div class="form-group"><label for="ep-a-email">Email for teachers to reach you</label>
            <input id="ep-a-email" type="email" data-a="email" value="${esc(v.email || '')}" autocomplete="email"></div>
          <div class="form-group"><label for="ep-a-phone">Phone <span class="tc-muted">(optional)</span></label>
            <input id="ep-a-phone" type="tel" data-a="phone" value="${esc(v.phone || '')}"></div>
          <div class="form-group eh-wide"><label for="ep-a-bring">What you'd bring to a class <span class="tc-muted">(a sentence or two)</span></label>
            <textarea id="ep-a-bring" rows="2" data-a="bring" placeholder="e.g. I study how cells sense stiffness and can bring gels students can squeeze.">${esc(v.bring || '')}</textarea></div>
        </div>
        <p class="eh-step-nav">
          <button type="button" class="btn btn-secondary btn-small" data-cancel-about>Cancel</button>
          <button type="button" class="btn btn-primary btn-small eh-next" data-save-about>${pr ? 'Save' : 'Save and see openings'}</button>
        </p>
      </div>`;
  }
  function wireAbout(root) {
    root.querySelector('[data-edit-about]')?.addEventListener('click', () => { view.editAbout = true; paint(root); });
    root.querySelector('[data-cancel-about]')?.addEventListener('click', () => { view.editAbout = false; paint(root); });
    if (view.editAbout) root.querySelector('[data-a="name"]')?.focus({ preventScroll: true });
    root.querySelector('[data-save-about]')?.addEventListener('click', async () => {
      const get = (key) => root.querySelector(`[data-a="${key}"]`).value.trim();
      const data = { name: get('name'), affiliation: get('affiliation'), title: get('title'),
        email: get('email'), phone: get('phone'), bring: get('bring') };
      if (!data.name || !data.affiliation) { setStatus('Add your name and where you work or study.', true, 'ep-about-status'); return; }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) { setStatus('Add an email address teachers can reach you at.', true, 'ep-about-status'); return; }
      try {
        await src().savePresenter(S.uid, data);
        view.editAbout = false;
        await load(root);
        setStatus('Saved. Now pick an opening to ask for a visit.');
        document.getElementById('ep-find')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      } catch (e) { setStatus('Could not save: ' + e.message, true, 'ep-about-status'); }
    });
  }

  /* ---- Your visits ---- */
  function visitsHTML() {
    const k = K(); const esc = k.esc;
    const today = k.todayISO();
    const mine = S.mine.slice().sort((a, b) => k.reqWhen(a).localeCompare(k.reqWhen(b)));
    if (!mine.length) return '';
    const school = (r) => S.listed.get(r.teacherUid)?.school || 'the school';
    const lastPick = (r) => (r.dates || []).slice().sort().pop() || r.date || '';
    const due = mine.filter(r => r.status === 'confirmed' && String(r.date) < today && !S.reviewByReq.has(r.id));
    const pending = mine.filter(r => r.status === 'pending' && lastPick(r) >= today);
    const upcoming = mine.filter(r => r.status === 'confirmed' && String(r.date) >= today);
    const past = mine.filter(r => !due.includes(r) && !pending.includes(r) && !upcoming.includes(r)).reverse();
    const title = (r) => r.opportunityTitle || S.opps.find(o => o.id === r.opportunityId)?.title || '';
    const head = (r) => `${r.date
        ? `<strong>${esc(k.fmtDay(r.date))}</strong> ${esc(r.startTime || '')}–${esc(r.endTime || '')} · `
        : ''}<strong>${esc(school(r))}</strong>${title(r) ? ` — ${esc(title(r))}` : ''}
      <span class="tc-muted eh-req-what">${esc(k.label(k.ACTIVITY_TYPES, r.activityType))} · ${esc(k.label(k.FORMATS, r.format))}${r.topic ? ' · ' + esc(r.topic) : ''}</span>
      ${!r.date && (r.dates || []).length ? `<span class="eh-req-dates">You offered: ${r.dates.slice().sort().map(d => `<span class="eh-opening">${esc(k.fmtDay(d))}</span>`).join('')}</span>` : ''}`;
    return `
      <div class="dash-card ep-visits" id="ep-visits">
        <h3>Your visits</h3>
        <div id="ep-visits-status" class="teach-status" hidden></div>
        ${due.length ? `<div class="eh-sublist"><h5>Tell us how it went</h5>
          ${due.map(r => `<div class="eh-req-row ep-due" data-req="${esc(r.id)}">
            <span class="tc-chip tc-chip-pending">review due</span> ${head(r)}
            ${view.reviewing === r.id ? reviewFormHTML(r) : `<p><button type="button" class="btn btn-primary btn-small" data-review="${esc(r.id)}">Write a short review</button></p>`}
          </div>`).join('')}</div>` : ''}
        ${pending.length ? `<div class="eh-sublist"><h5>Waiting on the teacher</h5>
          ${pending.map(r => `<div class="eh-req-row" data-req="${esc(r.id)}">
            <span class="tc-chip tc-chip-pending">pending</span> ${head(r)}
            <p class="tc-muted">The teacher will pick one of your dates when they accept.</p>
            <p><button type="button" class="btn btn-secondary btn-small" data-cancel-req>Withdraw</button></p>
          </div>`).join('')}</div>` : ''}
        ${upcoming.length ? `<div class="eh-sublist"><h5>Coming up</h5>
          ${upcoming.map(r => `<div class="eh-req-row" data-req="${esc(r.id)}">
            <span class="tc-chip tc-chip-approved">accepted</span> ${head(r)}
            ${r.expectedStudents ? `<p><strong>${esc(String(r.expectedStudents))} students</strong> expected.</p>` : ''}
            ${r.location && r.location.address ? `<div class="eh-location"><strong>Where to go:</strong> ${esc(r.location.address)}${r.location.room ? ' · ' + esc(r.location.room) : ''}${r.location.phone ? ' · ' + esc(r.location.phone) : ''}
              ${r.location.arrivalNotes ? `<p class="tc-muted">${esc(r.location.arrivalNotes)}</p>` : ''}</div>` : ''}
            ${r.teacherNote ? `<p class="tc-muted">Teacher: ${esc(r.teacherNote)}</p>` : ''}
            <p class="tc-muted">${r.emailedAt ? 'The teacher has emailed you the details.' : 'The teacher will email you the details.'}</p>
          </div>`).join('')}</div>` : ''}
        ${past.length ? `<details class="eh-sublist eh-past"><summary>Past (${past.length})</summary>
          ${past.map(r => {
            const rev = S.reviewByReq.get(r.id);
            const status = r.status === 'pending' ? 'no answer' : r.status;
            return `<div class="eh-req-row" data-req="${esc(r.id)}">
              <span class="tc-chip ${r.status === 'confirmed' ? 'tc-chip-approved' : 'tc-chip-denied'}">${esc(rev ? 'reviewed ✓' : status)}</span> ${head(r)}
              ${rev ? (view.reviewing === r.id ? reviewFormHTML(r, rev)
                : `<p><button type="button" class="btn btn-secondary btn-small" data-review="${esc(r.id)}">Edit your review</button></p>`) : ''}
            </div>`;
          }).join('')}</details>` : ''}
      </div>`;
  }

  function reviewFormHTML(r, rev) {
    const esc = K().esc;
    rev = rev || {};
    const scale = (name, val, lo, hi) => `
      <div class="eh-seg ep-scale" role="radiogroup">
        ${[1, 2, 3, 4, 5].map(n => `<label><input type="radio" name="${name}-${esc(r.id)}" data-rv="${name}" value="${n}"${Number(val) === n ? ' checked' : ''}> ${n}</label>`).join('')}
      </div><span class="tc-muted ep-scale-ends">1 = ${lo} · 5 = ${hi}</span>`;
    return `
      <form class="ep-review" data-review-form="${esc(r.id)}" novalidate>
        <p class="tc-muted">The teacher and the McGhee Lab will read this.</p>
        <div class="form-group"><label>Overall, how did the visit go?</label>${scale('rating', rev.rating, 'badly', 'really well')}</div>
        <div class="form-group"><label>How engaged were the students?</label>${scale('engagement', rev.engagement, 'not at all', 'completely')}</div>
        <div class="eh-fields">
          <div class="form-group"><label>About how many students were there?</label>
            <input type="number" min="0" max="500" data-rv="studentsReached" value="${esc(String(rev.studentsReached ?? r.expectedStudents ?? ''))}"></div>
          <div class="form-group"><label>Would you visit this class again?</label>
            <select data-rv="wouldReturn">
              ${[['yes', 'Yes'], ['maybe', 'Maybe'], ['no', 'No']].map(([v, l]) => `<option value="${v}"${rev.wouldReturn === v ? ' selected' : ''}>${l}</option>`).join('')}
            </select></div>
        </div>
        <div class="form-group"><label>What went well?</label>
          <textarea rows="2" data-rv="wentWell">${esc(rev.wentWell || '')}</textarea></div>
        <div class="form-group"><label>What would make it better next time?</label>
          <textarea rows="2" data-rv="improve">${esc(rev.improve || '')}</textarea></div>
        <p class="eh-step-nav">
          <button type="button" class="btn btn-secondary btn-small" data-review-cancel>Cancel</button>
          <button type="submit" class="btn btn-primary btn-small eh-next">${rev.rating ? 'Save review' : 'Send review'}</button>
        </p>
      </form>`;
  }

  function wireVisits(root) {
    root.querySelectorAll('[data-review]').forEach(b => b.addEventListener('click', () => {
      view.reviewing = b.dataset.review; paint(root);
      root.querySelector('.ep-review')?.scrollIntoView({ block: 'nearest' });
    }));
    root.querySelector('[data-review-cancel]')?.addEventListener('click', () => { view.reviewing = null; paint(root); });
    root.querySelector('.ep-review')?.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const form = ev.currentTarget;
      const reqId = form.dataset.reviewForm;
      const r = S.mine.find(x => x.id === reqId);
      const val = (k) => form.querySelector(`[data-rv="${k}"]:checked`)?.value || form.querySelector(`[data-rv="${k}"]:not([type=radio])`)?.value || '';
      const rating = Number(val('rating')), engagement = Number(val('engagement'));
      if (!rating || !engagement) { setStatus('Pick a number for both questions at the top.', true, 'ep-visits-status'); return; }
      const isNew = !S.reviewByReq.has(reqId);
      try {
        await src().saveEngageReview(reqId, {
          requesterUid: S.uid, teacherUid: r.teacherUid,
          requesterName: S.presenter?.name || r.requesterName || '', visitDate: r.date,
          rating, engagement,
          studentsReached: Number(val('studentsReached')) || null,
          wouldReturn: val('wouldReturn') || 'yes',
          wentWell: val('wentWell').trim(), improve: val('improve').trim()
        }, isNew);
        view.reviewing = null;
        await load(root);
        setStatus(isNew ? 'Thank you. Your review is with the teacher and the lab.' : 'Review updated.', false, 'ep-visits-status');
      } catch (e) { setStatus('Could not save: ' + e.message, true, 'ep-visits-status'); }
    });
    root.querySelectorAll('#ep-visits [data-cancel-req]').forEach(btn => btn.addEventListener('click', () =>
      K().armConfirm(btn, async () => {
        try {
          await src().cancelEngageRequest(btn.closest('.eh-req-row').dataset.req);
          await load(root);
          setStatus('Request cancelled.', false, 'ep-visits-status');
        } catch (e) { setStatus('Could not cancel: ' + e.message, true, 'ep-visits-status'); }
      })));
  }

  /* ---- Find a classroom: static toolbar, re-rendered results ---- */
  function toolbarHTML() {
    const k = K(); const esc = k.esc; const f = view.f;
    const chips = (group, pairs, set) => pairs.map(([v, l]) =>
      `<button type="button" class="ep-chip" data-chip="${group}" data-v="${esc(v)}" aria-pressed="${set.has(String(v)) ? 'true' : 'false'}">${esc(l)}</button>`).join('');
    const schools = S.profiles.slice().sort((a, b) => String(a.school).localeCompare(String(b.school)));
    const max = k.addDays(k.todayISO(), HORIZON_DAYS - 1);
    return `
      <div class="ep-bar" id="ep-bar">
        <div class="ep-bar-row">
          <input type="search" id="ep-q" class="ep-q" placeholder="Search opportunities, schools, subjects, topics" value="${esc(f.q)}" aria-label="Search">
          <select id="ep-school" aria-label="School">
            <option value="">All schools</option>
            ${schools.map(p => `<option value="${esc(p.teacherUid || p.id)}"${f.school === (p.teacherUid || p.id) ? ' selected' : ''}>${esc(p.school || p.displayName)}</option>`).join('')}
          </select>
          <label class="ep-date">From <input type="date" id="ep-from" value="${f.from}" min="${k.todayISO()}" max="${max}"></label>
          <label class="ep-date">To <input type="date" id="ep-to" value="${f.to}" min="${k.todayISO()}" max="${max}"></label>
        </div>
        <!-- V3.788: the chip rows start folded everywhere, so the calendar sits
             right under the search box; the summary says how many are on. -->
        <details class="ep-more" id="ep-more"${view.moreOpen ?? activeCount() > 0 ? ' open' : ''}>
          <summary>Filters <span class="tc-muted" id="ep-more-n">${activeCount() ? '(' + activeCount() + ' on)' : ''}</span></summary>
          <div class="ep-bar-row"><span class="ep-bar-label">School</span>${chips('types', k.SCHOOL_TYPES.filter(t => t[0] !== 'other'), f.types)}</div>
          <div class="ep-bar-row"><span class="ep-bar-label">Activity</span>${chips('acts', k.ACTIVITY_TYPES, f.acts)}</div>
          <div class="ep-bar-row"><span class="ep-bar-label">Where</span>${chips('fmts', k.FORMATS, f.fmts)}</div>
          <div class="ep-bar-row"><span class="ep-bar-label">Day</span>${chips('days', [1, 2, 3, 4, 5, 6, 0].map(d => [String(d), DOW[d]]), f.days)}</div>
          <div class="ep-bar-row"><span class="ep-bar-label">Time</span>${chips('tods', TOD, f.tods)}</div>
        </details>
        <div class="ep-bar-row"><button type="button" class="btn btn-secondary btn-small ep-clear" id="ep-clear">Clear filters</button></div>
        <div class="ep-bar-row ep-viewrow">
          <div class="eh-seg" role="radiogroup" aria-label="View">
            <label><input type="radio" name="ep-view" value="list"${view.mode === 'list' ? ' checked' : ''}> List</label>
            <label><input type="radio" name="ep-view" value="calendar"${view.mode === 'calendar' ? ' checked' : ''}> Calendar</label>
          </div>
        </div>
      </div>`;
  }

  function activeCount() {
    const f = view.f;
    return f.types.size + f.acts.size + f.fmts.size + f.days.size + f.tods.size;
  }
  function wireToolbar(root) {
    const bar = root.querySelector('#ep-bar');
    const f = view.f;
    const k = K();
    bar.querySelector('#ep-more').addEventListener('toggle', (e) => { view.moreOpen = e.target.open; });
    bar.querySelector('#ep-q').addEventListener('input', (e) => { f.q = e.target.value; renderResults(root); });
    bar.querySelector('#ep-school').addEventListener('change', (e) => { f.school = e.target.value; renderResults(root); });
    const clampDates = () => {
      const max = k.addDays(k.todayISO(), HORIZON_DAYS - 1);
      if (!f.from || f.from < k.todayISO()) f.from = k.todayISO();
      if (!f.to || f.to > max) f.to = max;
      if (f.to < f.from) f.to = f.from;
    };
    bar.querySelector('#ep-from').addEventListener('change', (e) => { f.from = e.target.value; clampDates(); renderResults(root); });
    bar.querySelector('#ep-to').addEventListener('change', (e) => { f.to = e.target.value; clampDates(); renderResults(root); });
    bar.addEventListener('click', (e) => {
      const chip = e.target.closest('[data-chip]');
      if (chip) {
        const set = f[chip.dataset.chip];
        const v = chip.dataset.v;
        set.has(v) ? set.delete(v) : set.add(v);
        chip.setAttribute('aria-pressed', set.has(v) ? 'true' : 'false');
        const n = activeCount();
        bar.querySelector('#ep-more-n').textContent = n ? '(' + n + ' on)' : '';
        renderResults(root);
        return;
      }
      if (e.target.closest('#ep-clear')) {
        view.f = freshFilters();
        view.day = null;
        paint(root);
      }
    });
    bar.querySelectorAll('[name="ep-view"]').forEach(r => r.addEventListener('change', () => {
      view.mode = bar.querySelector('[name="ep-view"]:checked').value;
      renderResults(root);
    }));
  }

  // Every opportunity with a date in the range, then the filters. A filter
  // on day / time / range passes if ANY of the opportunity's upcoming dates
  // does. The List uses the From/To inputs; the Calendar uses the month on
  // screen.
  function filteredOpps(from, to) {
    const k = K(); const f = view.f;
    const q = f.q.trim().toLowerCase();
    const today = k.todayISO();
    const lo = (from || f.from) < today ? today : (from || f.from);
    const hi = to || f.to;
    return S.opps.map(o => ({ o, prof: S.listed.get(o.teacherUid) || {},
      dates: k.oppDates(o).filter(d => d.date >= lo && d.date <= hi && d.date >= today && (!o.bookedDate || d.date === o.bookedDate)) }))
    .filter(x => {
      const { o, prof: p, dates } = x;
      if (!dates.length) return false;
      if (f.school && (p.teacherUid || p.id) !== f.school) return false;
      if (f.types.size && !f.types.has(p.schoolType || '')) return false;
      if (f.acts.size && !(o.activityTypes || []).some(a => f.acts.has(a))) return false;
      if (f.fmts.size && !(o.formats || []).some(v => f.fmts.has(v))) return false;
      if (f.days.size && !dates.some(d => f.days.has(String(k.fromISO(d.date).getDay())))) return false;
      if (f.tods.size && !dates.some(d => f.tods.has(todOf(d.startTime)))) return false;
      if (q) {
        const hay = [o.title, o.topic, p.displayName, p.school, p.city, ...(p.subjects || []), ...(p.topics || []),
          o.classContext?.subject].join(' ').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    })
    .sort((a, b) => a.dates[0].date.localeCompare(b.dates[0].date) || String(a.o.title).localeCompare(String(b.o.title)));
  }
  const oppCount = (list) => {
    const schools = new Set(list.map(x => x.o.teacherUid)).size;
    return `${list.length} ${list.length === 1 ? 'opportunity' : 'opportunities'} at ${schools} ${schools === 1 ? 'school' : 'schools'}`;
  };

  function renderResults(root) {
    const k = K();
    const out = root.querySelector('#ep-results');
    const sum = root.querySelector('#ep-summary');
    if (!out) return;
    root.querySelector('#ep-bar')?.classList.toggle('is-cal', view.mode === 'calendar');
    if (!S.profiles.length) {
      sum.textContent = '';
      out.innerHTML = '<p class="tc-muted">No classrooms are listed yet. Check back soon.</p>';
      return;
    }
    if (view.mode === 'calendar') { renderCalendar(root, out, sum); return; }
    const list = filteredOpps();
    sum.textContent = list.length ? oppCount(list) : '';
    if (!list.length) {
      out.innerHTML = '<p class="tc-muted">Nothing matches those filters. Try a wider date range or clear the filters.</p>';
      return;
    }
    out.innerHTML = list.slice(0, LIST_CAP).map(x => oppCardHTML(x)).join('') +
      (list.length > LIST_CAP ? `<p class="tc-muted">Showing the first ${LIST_CAP}. Narrow the dates or filters to see the rest.</p>` : '');
    wireCards(root, out, list);
  }

  // "School" off the end of a name, so a calendar chip reads "10:00 Sunnyside".
  function shortSchool(name) {
    const n = String(name || '').replace(/\s+(high school|community college|college|school)$/i, '').trim();
    return n || String(name || '');
  }

  // The month overview: a day shows every opportunity that lists it. Tapping
  // a day lists those opportunities, with that date pre-ticked on sign-up.
  function renderCalendar(root, out, sum) {
    const k = K(); const esc = k.esc;
    const today = k.todayISO();
    const last = k.addDays(today, HORIZON_DAYS - 1);
    const now = k.fromISO(today);
    const mk = (y, m) => y * 12 + m;
    const minK = mk(now.getFullYear(), now.getMonth());
    const maxD = k.fromISO(last), maxK = mk(maxD.getFullYear(), maxD.getMonth());
    if (!view.month) {
      const daysLeft = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate() - now.getDate() + 1;
      const monthEnd = k.isoLocal(new Date(now.getFullYear(), now.getMonth() + 1, 0));
      const leftThisMonth = filteredOpps(today, monthEnd).length;
      let d = now;
      if (daysLeft < 10 || !leftThisMonth) {
        const next = filteredOpps(k.addDays(monthEnd, 1), last)[0];
        d = next ? k.fromISO(next.dates[0].date) : new Date(now.getFullYear(), now.getMonth() + 1, 1);
      }
      view.month = { y: d.getFullYear(), m: d.getMonth() };
    }
    const hereK = mk(view.month.y, view.month.m);
    if (hereK < minK) view.month = { y: now.getFullYear(), m: now.getMonth() };
    if (hereK > maxK) view.month = { y: maxD.getFullYear(), m: maxD.getMonth() };
    const mFrom = k.isoLocal(new Date(view.month.y, view.month.m, 1));
    const mTo = k.isoLocal(new Date(view.month.y, view.month.m + 1, 0));
    const list = filteredOpps(mFrom < today ? today : mFrom, mTo > last ? last : mTo);

    const byDay = {};
    for (const x of list) for (const d of x.dates) (byDay[d.date] = byDay[d.date] || []).push({ ...x, when: d });
    const days = {};
    for (const [iso, arr] of Object.entries(byDay)) {
      const anyPending = arr.some(x => x.o.pendingCount > 0);
      days[iso] = {
        count: arr.length, tone: anyPending ? 'pending' : 'open',
        label: arr.map(x => (x.when.startTime || '') + ' ' + (x.prof.school || '')).join(', '),
        chips: arr.map(x => ({ text: `${x.when.startTime || ''} ${shortSchool(x.prof.school)}`, tone: x.o.pendingCount > 0 ? 'pending' : 'open' }))
      };
    }
    const monthName = new Date(view.month.y, view.month.m, 1).toLocaleDateString('en-US', { month: 'long' });
    sum.textContent = list.length
      ? `${oppCount(list)} with dates in ${monthName}`
      : `Nothing in ${monthName}${activeCount() || view.f.q || view.f.school ? ' that matches your filters' : ''}.`;
    if (view.day && !byDay[view.day]) view.day = null;
    const dayList = view.day ? byDay[view.day] : null;
    out.innerHTML = `
      ${k.monthGridHTML({
        year: view.month.y, month: view.month.m, days, minISO: today,
        selected: new Set(view.day ? [view.day] : []),
        canPrev: hereK > minK, canNext: hereK < maxK,
        legend: [['open', 'Open for sign-up'], ['pending', 'Someone has signed up (pending acceptance)']]
      })}
      <div class="ep-calday" id="ep-calday">
        ${dayList ? `<div class="ep-day"><h5>${esc(k.fmtDay(view.day))} <span class="tc-muted">— ${dayList.length} ${dayList.length === 1 ? 'opportunity' : 'opportunities'}</span></h5>
            ${dayList.map(x => oppCardHTML(x, view.day)).join('')}</div>`
          : `<p class="tc-muted">${list.length ? 'Tap a day to see the opportunities on it and sign up.' : 'Try the next month, or clear the filters.'}</p>`}
      </div>`;
    out.querySelector('.eh-cal').addEventListener('click', (e) => {
      const nav = e.target.closest('[data-cal-nav]');
      if (nav) {
        if (nav.disabled) return;
        const d = new Date(view.month.y, view.month.m + Number(nav.dataset.calNav), 1);
        view.month = { y: d.getFullYear(), m: d.getMonth() };
        view.day = null;
        renderResults(root);
        root.querySelector(`#ep-results [data-cal-nav="${nav.dataset.calNav}"]`)?.focus({ preventScroll: true });
        return;
      }
      const cell = e.target.closest('[data-day]');
      if (cell && !cell.disabled) {
        view.day = byDay[cell.dataset.day] ? (view.day === cell.dataset.day ? null : cell.dataset.day) : null;
        view.openKey = null;
        renderResults(root);
        if (view.day) document.getElementById('ep-calday')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    });
    wireCards(root, out, list);
  }

  // One opportunity, with its dates, its flags and the sign-up form.
  // `preDate` (from the calendar) pre-ticks that date.
  function oppCardHTML(x, preDate) {
    const k = K(); const esc = k.esc;
    const { o, prof: p, dates } = x;
    const mine = S.mineByOpp.get(o.id);
    const wanted = o.presentersWanted || 1;
    const accepted = o.acceptedCount || (o.acceptedRequestIds || []).length || 0;
    const canAsk = S.presenter && !S.presenter.blocked && !mine;
    const open = view.openKey === o.id;
    const acts = (o.activityTypes || []).length ? o.activityTypes : (p.activityTypes || []);
    const fmts = (o.formats || []).length ? o.formats : (p.formats || []);
    const flags = [];
    if (mine) flags.push(`<span class="eh-flag ${mine.status === 'confirmed' ? 'eh-flag-booked' : 'eh-flag-pending'}">${mine.status === 'confirmed' ? 'You’re accepted' : 'You signed up · waiting on the teacher'}</span>`);
    else if (o.pendingCount > 0) flags.push(`<span class="eh-flag eh-flag-pending">Pending acceptance · ${o.pendingCount === 1 ? 'someone has' : o.pendingCount + ' people have'} signed up — the teacher will choose${wanted > 1 ? '' : '; you can still sign up'}</span>`);
    if (wanted > 1) flags.push(`<span class="eh-flag eh-flag-open">Up to ${wanted} presenters together${accepted ? ` · ${accepted} accepted so far` : ''}${o.bookedDate ? ` · date set: ${esc(k.fmtDay(o.bookedDate))}` : ''}</span>`);
    return `
      <div class="eh-opp ep-opp${open ? ' is-open' : ''}" data-opp="${esc(o.id)}">
        <div class="eh-opp-head">
          <strong>${esc(o.title || 'Opportunity')}</strong>
          ${p.schoolType ? `<span class="tc-chip tc-chip-draft">${esc(k.label(k.SCHOOL_TYPES, p.schoolType))}</span>` : ''}
        </div>
        <span><strong>${esc(p.school || 'School')}</strong> <span class="tc-muted">${esc(p.city || '')}</span></span>
        <span class="tc-muted">${esc([p.displayName, k.ctxLine(o.classContext)].filter(Boolean).join(' · '))}</span>
        <span class="tc-muted">${acts.map(a => esc(k.label(k.ACTIVITY_TYPES, a))).join(' · ')}${fmts.length ? ' — ' + fmts.map(v => esc(k.label(k.FORMATS, v))).join(' / ') : ''}${o.topic ? ' · ' + esc(o.topic) : ''}</span>
        <div class="eh-opp-dates">
          ${dates.map(d => `<span class="eh-opening${o.bookedDate === d.date ? ' is-booked' : ''}${preDate === d.date ? ' is-day' : ''}">${esc(k.fmtDay(d.date))} · ${esc(d.startTime || '')}–${esc(d.endTime || '')}</span>`).join('')}
        </div>
        ${flags.length ? `<div class="eh-opp-flags">${flags.join('')}</div>` : ''}
        <div class="ep-opp-act">
          ${mine ? '' : canAsk
            ? `<button type="button" class="btn btn-primary btn-small" data-ask>${open ? 'Close' : 'Sign up'}</button>`
            : S.presenter ? '' : '<button type="button" class="btn btn-secondary btn-small" data-need-about>Add your details to sign up</button>'}
        </div>
        ${canAsk ? `
        <form class="eh-req-form ep-req-form"${open ? '' : ' hidden'} novalidate>
          <fieldset class="eh-choices eh-choices-inline">
            <legend>${o.bookedDate ? 'The date is set' : 'Which of these dates could you do? Tick all that work.'}</legend>
            ${dates.map(d => `<label class="eh-choice"><input type="checkbox" data-rq-date value="${esc(d.date)}"${(o.bookedDate === d.date || (!o.bookedDate && preDate === d.date)) ? ' checked' : ''}${o.bookedDate ? ' disabled' : ''}>
              <span><strong>${esc(k.fmtDay(d.date))}</strong><span class="tc-muted">${esc(d.startTime || '')}–${esc(d.endTime || '')}</span></span></label>`).join('')}
          </fieldset>
          <div class="eh-fields">
            <div class="form-group"><label>Your part</label>
              <select data-rq-activity>${acts.map(a => `<option value="${esc(a)}">${esc(k.label(k.ACTIVITY_TYPES, a))}</option>`).join('')}</select></div>
            <div class="form-group"><label>Where</label>
              <select data-rq-format>${fmts.map(v => `<option value="${esc(v)}">${esc(k.label(k.FORMATS, v))}</option>`).join('')}</select></div>
          </div>
          <div class="form-group"><label>What you'd talk about or do</label>
            <input type="text" data-rq-topic placeholder="${esc(o.topic || 'e.g. how we 3D-print tissue')}"></div>
          <div class="form-group"><label>A note to the teacher <span class="tc-muted">(optional)</span></label>
            <textarea data-rq-msg rows="2" placeholder="Anything they should know: equipment, how long you need, room setup…"></textarea></div>
          <label class="eh-choice ep-okothers"><input type="checkbox" data-rq-others${wanted > 1 ? ' checked' : ''}>
            <span><strong>Happy to share the session with another presenter</strong>${wanted > 1 ? '<span class="tc-muted">This teacher is hoping for several presenters together.</span>' : ''}</span></label>
          <p class="eh-step-nav"><button type="submit" class="btn btn-primary btn-small eh-next">Sign up</button></p>
        </form>` : ''}
      </div>`;
  }

  function wireCards(root, out, list) {
    const find = (el) => { const id = el.closest('.ep-opp').dataset.opp; return list.find(x => x.o.id === id); };
    out.querySelectorAll('[data-need-about]').forEach(b => b.addEventListener('click', () => {
      view.editAbout = true;
      paint(root);
      document.getElementById('ep-about')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }));
    out.querySelectorAll('[data-ask]').forEach(b => b.addEventListener('click', () => {
      const card = b.closest('.ep-opp');
      const id = card.dataset.opp;
      const opening = view.openKey !== id;
      view.openKey = opening ? id : null;
      out.querySelectorAll('.ep-opp.is-open').forEach(c => {
        if (c === card) return;
        c.classList.remove('is-open');
        const fm = c.querySelector('.ep-req-form'); if (fm) fm.hidden = true;
        const bt = c.querySelector('[data-ask]'); if (bt) bt.textContent = 'Sign up';
      });
      card.classList.toggle('is-open', opening);
      const form = card.querySelector('.ep-req-form');
      if (form) form.hidden = !opening;
      b.textContent = opening ? 'Close' : 'Sign up';
      if (opening) (form?.querySelector('[data-rq-date]:not(:checked):not(:disabled)') || form?.querySelector('[data-rq-topic]'))?.focus({ preventScroll: true });
    }));
    out.querySelectorAll('.ep-req-form').forEach(form => form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const x = find(form);
      if (!x) return;
      const { o, prof: p } = x;
      const pr = S.presenter;
      const picks = o.bookedDate ? [o.bookedDate] : [...form.querySelectorAll('[data-rq-date]:checked')].map(i => i.value);
      if (!picks.length) { setStatus('Tick at least one date you could do.', true, 'ep-find-status'); form.querySelector('[data-rq-date]')?.focus(); return; }
      try {
        await src().createEngageRequest({
          opportunityId: o.id,
          opportunityTitle: o.title || '',
          teacherUid: o.teacherUid,
          requesterUid: S.uid,
          requesterName: pr.name,
          requesterAffiliation: pr.affiliation,
          requesterTitle: pr.title || '',
          requesterBio: pr.bring || '',
          requesterEmail: pr.email,
          dates: picks.sort(),
          okWithOthers: form.querySelector('[data-rq-others]').checked,
          activityType: form.querySelector('[data-rq-activity]').value,
          format: form.querySelector('[data-rq-format]').value,
          topic: form.querySelector('[data-rq-topic]').value.trim(),
          message: form.querySelector('[data-rq-msg]').value.trim()
        });
        view.openKey = null;
        await load(root);
        setStatus(`You're signed up for "${o.title || 'the opportunity'}" at ${p.school || 'the school'}. The teacher will pick a date and accept or decline; it's under Your visits.`);
        document.getElementById('ep-status')?.scrollIntoView({ block: 'nearest' });
      } catch (e) { setStatus('Could not sign up: ' + e.message, true, 'ep-find-status'); }
    }));
  }

  /* ================================================================
     EXPORTS
     ================================================================ */
  ML.renderPresentersPage = renderPresentersPage;
  ML.wirePresentersPage = wirePresentersPage;
})();
