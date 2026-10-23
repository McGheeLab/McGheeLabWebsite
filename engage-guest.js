/* ================================================================
   INVITE A SCIENTIST — #/invite-a-scientist (V3.808)
   ----------------------------------------------------------------
   Alex: "I need to be able to have teachers add engagement
   opportunities as a guest, so they do not need to sign in. I believe
   there is a hurdle right now for teachers to spark an engagement
   opportunity based on the fact that they would need to make a sign in."

   The no-account front door for teachers. Two screens:

   • #/invite-a-scientist — ONE form: you and your school, your class,
     the visit you'd like with every date that works, where visitors go,
     a note to the lab. Posting returns a private link.
   • #/invite-a-scientist/{token} — the teacher's private page: status
     (waiting for the lab's review → live → booked), the sign-ups, and the
     same accept / decline / confirmation-email / cancel loop as step 7 of
     the signed-in panel (engage-hub.js), down to the identical email
     (ML.EngageKit.buildVisitEmail).

   There is no Firestore access here at all: every read and write is a
   POST to the engageGuest Cloud Function (functions/engage-guest.js),
   which finds the post by its token with the Admin SDK. The rules keep
   engageGuestPosts admin-only. The McGhee Lab reviews each post in
   rm/pages/admin-teachers.html?tab=engage before presenters see it.

   localStorage holds only per-browser conveniences: an unsent draft and
   the links of posts made from this browser. Every access is wrapped —
   the page works without it. No window.prompt/alert/confirm.

   Loaded after engage-hub.js (the kit) and engage-presenters.js.
   ================================================================ */
(function () {
  'use strict';

  const ML = window.McgheeLab = window.McgheeLab || {};
  const FN_URL = 'https://us-central1-mcgheelab-f56cc.cloudfunctions.net/engageGuest';
  const ROUTE = '#/invite-a-scientist';
  const SITE = 'https://mcgheelab.com/';
  const LS_POSTS = 'mcgheelab.engageGuest.posts';
  const LS_DRAFT = 'mcgheelab.engageGuest.draft';
  const MAX_DATES = 12;
  const LAB_EMAIL = 'mcgheealex@arizona.edu';

  const K = () => ML.EngageKit;
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : (many || one + 's'));
  const linkOf = (token) => SITE + ROUTE + '/' + token;

  function lsGet(key, fallback) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; }
  }
  function lsSet(key, value) {
    try { value == null ? localStorage.removeItem(key) : localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* private mode */ }
  }
  function rememberPost(token, title, school) {
    const list = (lsGet(LS_POSTS, []) || []).filter(x => x && x.token !== token);
    list.unshift({ token, title, school, at: Date.now() });
    lsSet(LS_POSTS, list.slice(0, 10));
  }

  async function call(action, payload) {
    let res;
    try {
      res = await fetch(FN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({ action }, payload || {}))
      });
    } catch (e) {
      const err = new Error('We couldn’t reach the McGhee Lab server. Check your connection and try again.');
      err.status = 0;
      throw err;
    }
    let data = {};
    try { data = await res.json(); } catch (e) { /* non-JSON error page */ }
    if (!res.ok) {
      const err = new Error(data.error || ('Something went wrong (' + res.status + '). Please try again.'));
      err.status = res.status;
      throw err;
    }
    return data;
  }

  async function copyText(text, fallbackEl) {
    try { await navigator.clipboard.writeText(text); return true; } catch (e) { /* fall back */ }
    if (fallbackEl && fallbackEl.select) {
      fallbackEl.focus(); fallbackEl.select();
      try { return document.execCommand('copy'); } catch (e) { return false; }
    }
    return false;
  }

  /* ================================================================
     ENTRY
     ================================================================ */
  function renderGuestPage() {
    return `<div class="dashboard-page teach-page eg-page" id="eg-root">
      <p class="loading-text">Loading…</p>
    </div>`;
  }

  async function wireGuestPage(subParts) {
    const root = document.getElementById('eg-root');
    if (!root) return;
    if (!K()) {
      root.innerHTML = `<div class="dash-card"><p class="error-text">This page didn't finish loading. Refresh to try again.</p></div>`;
      return;
    }
    const token = String((subParts || [])[0] || '').split('?')[0];
    if (token) await showManage(root, token);
    else showForm(root, null);
  }

  /* ================================================================
     THE FORM — new post, or editing one still waiting for review
     ================================================================ */
  let draft = null;     // the form's values; survives a re-render of the date list
  let editing = null;   // { token } while editing a pending post

  function blankDraft() {
    return {
      name: '', email: '', phone: '',
      school: '', schoolType: 'high-school', city: '', state: 'AZ',
      subject: '', grade: '', classSize: '',
      title: '', activityTypes: [], formats: [], topic: '',
      panel: false, presentersWanted: 2,
      dates: [{ date: '', startTime: '10:00', endTime: '10:50' }],
      address: '', room: '', arrivalNotes: '', noteToLab: ''
    };
  }
  function draftFromPost(post) {
    const o = post.opportunity || {};
    return {
      name: post.teacher.name || '', email: post.teacher.email || '', phone: post.teacher.phone || '',
      school: post.listing.school || '', schoolType: post.listing.schoolType || 'high-school',
      city: post.listing.city || '', state: post.listing.state || 'AZ',
      subject: post.listing.subject || '', grade: post.listing.grade || '', classSize: String(post.listing.classSize || ''),
      title: o.title || '', activityTypes: (o.activityTypes || []).slice(), formats: (o.formats || []).slice(),
      topic: o.topic || '', panel: (o.presentersWanted || 1) > 1, presentersWanted: Math.max(2, o.presentersWanted || 2),
      dates: (o.dates || []).map(d => ({ ...d })),
      address: post.location.address || '', room: post.location.room || '', arrivalNotes: post.location.arrivalNotes || '',
      noteToLab: post.noteToLab || ''
    };
  }

  const ACT_HINTS = {
    'guest-talk': 'A researcher talks about their work and takes questions',
    'demo': 'Something hands-on the class can try',
    'lab-tour': 'A walk through a working research lab',
    'career-chat': 'What the job is like and how people got there'
  };
  const FMT_HINTS = {
    'at-school': 'A presenter comes to your classroom',
    'visit-uofa': 'Your class comes to the University of Arizona',
    'virtual': 'Over video'
  };

  function field(id, labelHTML, inputHTML, help) {
    return `<div class="form-group eg-field" data-field="${id}">
      <label for="eg-${id}">${labelHTML}</label>
      ${inputHTML}
      ${help ? `<p class="eg-help">${help}</p>` : ''}
      <p class="eg-err" data-err="${id}" hidden></p>
    </div>`;
  }
  const inp = (id, value, attrs) => `<input id="eg-${id}" name="${id}" value="${esc(value)}" ${attrs || 'type="text"'}>`;

  function myPostsHTML() {
    const list = (lsGet(LS_POSTS, []) || []).filter(x => x && x.token);
    if (!list.length) return '';
    return `
      <div class="dash-card eg-mine">
        <h3>Your posts from this browser</h3>
        <ul class="eg-mine-list">
          ${list.map(x => `<li><a href="${ROUTE}/${esc(x.token)}">${esc(x.title || 'Your visit post')}</a>
            <span class="tc-muted">${esc(x.school || '')}</span></li>`).join('')}
        </ul>
      </div>`;
  }

  function datesHTML() {
    const today = K().todayISO();
    const rows = draft.dates.map((d, i) => `
      <div class="eg-daterow" data-i="${i}">
        <label class="eg-date"><span class="eh-sr">Date ${i + 1}</span>
          <input type="date" data-d="date" min="${today}" value="${esc(d.date)}" aria-label="Date ${i + 1}"></label>
        <label><span>from</span> <input type="time" data-d="startTime" step="300" value="${esc(d.startTime)}" aria-label="Start time for date ${i + 1}"></label>
        <label><span>to</span> <input type="time" data-d="endTime" step="300" value="${esc(d.endTime)}" aria-label="End time for date ${i + 1}"></label>
        ${draft.dates.length > 1 ? `<button type="button" class="btn btn-secondary btn-small" data-d-remove aria-label="Remove date ${i + 1}">Remove</button>` : ''}
      </div>`).join('');
    return `${rows}
      ${draft.dates.length < MAX_DATES ? `<p><button type="button" class="btn btn-secondary btn-small" data-d-add>+ Add another date</button></p>` : ''}`;
  }

  function formHTML() {
    const kit = K();
    const d = draft;
    const atSchool = d.formats.includes('at-school');
    return `
      <form id="eg-form" class="eg-form" novalidate>
        <section class="dash-card eg-card">
          <h3><span class="eg-num">1</span> You and your school</h3>
          <div class="eg-grid">
            ${field('name', 'Your name', inp('name', d.name, 'type="text" autocomplete="name" maxlength="120"'))}
            ${field('email', 'Your email', inp('email', d.email, 'type="email" autocomplete="email" maxlength="200"'),
              'We send your private link here. Presenters you accept will hear from you at this address.')}
            ${field('phone', 'Phone <span class="tc-muted">(optional)</span>', inp('phone', d.phone, 'type="tel" autocomplete="tel" maxlength="40"'),
              'Only shared with a presenter you accept, for the day of the visit.')}
            ${field('school', 'School', inp('school', d.school, 'type="text" autocomplete="organization" maxlength="160"'))}
            ${field('city', 'City', inp('city', d.city, 'type="text" autocomplete="address-level2" maxlength="80"'))}
            ${field('state', 'State', inp('state', d.state, 'type="text" autocomplete="address-level1" maxlength="40"'))}
          </div>
          <fieldset class="eh-choices eh-choices-inline" data-field="schoolType">
            <legend>School type</legend>
            ${kit.SCHOOL_TYPES.map(([k, l]) => `<label class="eh-choice"><input type="radio" name="schoolType" value="${k}"${d.schoolType === k ? ' checked' : ''}> <span><strong>${esc(l)}</strong></span></label>`).join('')}
          </fieldset>
        </section>

        <section class="dash-card eg-card">
          <h3><span class="eg-num">2</span> Your class</h3>
          <div class="eg-grid">
            ${field('subject', 'Subject', inp('subject', d.subject, 'type="text" maxlength="120" placeholder="e.g. AP Biology"'))}
            ${field('grade', 'Grade level', inp('grade', d.grade, 'type="text" maxlength="40" placeholder="e.g. 11–12"'))}
            ${field('classSize', 'Class size', inp('classSize', d.classSize, 'type="number" min="1" max="500" inputmode="numeric" placeholder="e.g. 28"'))}
          </div>
        </section>

        <section class="dash-card eg-card">
          <h3><span class="eg-num">3</span> The visit you'd like</h3>
          ${field('title', 'What would you like? <span class="tc-muted">(the title presenters see)</span>',
            inp('title', d.title, 'type="text" maxlength="140" placeholder="e.g. Guest talk on careers in biomedical engineering"'))}
          <fieldset class="eh-choices eh-choices-inline" data-field="activityTypes">
            <legend>Kind of visit <span class="tc-muted">(tick all you'd welcome)</span></legend>
            ${kit.ACTIVITY_TYPES.map(([k, l]) => `<label class="eh-choice"><input type="checkbox" name="activityTypes" value="${k}"${d.activityTypes.includes(k) ? ' checked' : ''}>
              <span><strong>${esc(l)}</strong><span class="tc-muted">${esc(ACT_HINTS[k] || '')}</span></span></label>`).join('')}
            <p class="eg-err" data-err="activityTypes" hidden></p>
          </fieldset>
          <fieldset class="eh-choices eh-choices-inline" data-field="formats">
            <legend>Where</legend>
            ${kit.FORMATS.map(([k, l]) => `<label class="eh-choice"><input type="checkbox" name="formats" value="${k}"${d.formats.includes(k) ? ' checked' : ''}>
              <span><strong>${esc(l)}</strong><span class="tc-muted">${esc(FMT_HINTS[k] || '')}</span></span></label>`).join('')}
            <p class="eg-err" data-err="formats" hidden></p>
          </fieldset>
          ${field('topic', 'Topic or details <span class="tc-muted">(optional)</span>',
            inp('topic', d.topic, 'type="text" maxlength="300" placeholder="e.g. anything hands-on about cells; 40 minutes plus questions"'))}
          <fieldset class="eh-choices eh-choices-inline" data-field="panel">
            <legend>How many presenters?</legend>
            <label class="eh-choice"><input type="radio" name="panel" value="one"${!d.panel ? ' checked' : ''}> <span><strong>One presenter</strong></span></label>
            <label class="eh-choice"><input type="radio" name="panel" value="several"${d.panel ? ' checked' : ''}> <span><strong>Several together</strong><span class="tc-muted">a panel, on one date</span></span></label>
          </fieldset>
          <div class="form-group eg-field" data-panel-count${d.panel ? '' : ' hidden'}>
            <label for="eg-presentersWanted">Up to how many?</label>
            <select id="eg-presentersWanted" name="presentersWanted">
              ${[2, 3, 4, 5, 6].map(n => `<option value="${n}"${d.presentersWanted === n ? ' selected' : ''}>${n}</option>`).join('')}
            </select>
          </div>
          <div class="eg-field" data-field="dates">
            <p class="eg-label">Dates that would work <span class="tc-muted">(add every one you can; the presenter tells you which they can do, and you pick)</span></p>
            <div id="eg-dates">${datesHTML()}</div>
            <p class="eg-err" data-err="dates" hidden></p>
          </div>
        </section>

        <section class="dash-card eg-card" data-where${atSchool ? '' : ' hidden'}>
          <h3><span class="eg-num">4</span> Where visitors go</h3>
          <p class="eh-step-lead tc-muted">Private. Only a presenter you accept gets this, in the confirmation email.</p>
          ${field('address', 'School street address', inp('address', d.address, 'type="text" autocomplete="street-address" maxlength="300"'))}
          <div class="eg-grid">
            ${field('room', 'Room <span class="tc-muted">(optional)</span>', inp('room', d.room, 'type="text" maxlength="80" placeholder="e.g. B-114"'))}
          </div>
          ${field('arrivalNotes', 'Checking in <span class="tc-muted">(optional)</span>',
            `<textarea id="eg-arrivalNotes" name="arrivalNotes" rows="2" maxlength="600" placeholder="e.g. Park in the visitor lot and sign in at the front office.">${esc(d.arrivalNotes)}</textarea>`)}
        </section>

        <section class="dash-card eg-card">
          <h3><span class="eg-num">${atSchool ? 5 : 4}</span> Anything else for the McGhee Lab? <span class="tc-muted">(optional)</span></h3>
          ${field('noteToLab', '<span class="eh-sr">Note to the McGhee Lab</span>',
            `<textarea id="eg-noteToLab" name="noteToLab" rows="3" maxlength="1000" placeholder="Questions, or anything that would help us find the right presenter">${esc(d.noteToLab)}</textarea>`)}
          <div class="eg-hp" aria-hidden="true">
            <label>Company website <input type="text" name="company_url" tabindex="-1" autocomplete="off"></label>
          </div>
          <div class="eg-submit">
            <button type="submit" class="btn btn-primary" id="eg-submit">${editing ? 'Save changes' : 'Post it'}</button>
            ${editing ? `<button type="button" class="btn btn-secondary" data-cancel-edit>Cancel</button>` : ''}
            <span class="eg-status" id="eg-form-status" role="status" aria-live="polite"></span>
          </div>
          <p class="eg-fine">The McGhee Lab shows your name, school, class and dates to presenters. Your email,
            phone and the school's address are never shown; the address goes only to a presenter you accept.</p>
        </section>
      </form>`;
  }

  function showForm(root, editPost) {
    editing = editPost ? { token: editPost.token } : null;
    draft = editPost ? draftFromPost(editPost.post) : (lsGet(LS_DRAFT, null) || blankDraft());
    if (!Array.isArray(draft.dates) || !draft.dates.length) draft.dates = blankDraft().dates;
    root.innerHTML = `
      <div class="dash-header"><h2>${editing ? 'Edit your visit post' : 'Invite a scientist to your class'}</h2></div>
      ${editing ? `<div class="dash-card"><p class="tc-muted" style="margin:0">You can change anything until the McGhee Lab publishes it.</p></div>` : `
      <div class="dash-card eg-intro">
        <p>University of Arizona researchers and other science professionals visit classes for a guest
          talk, a hands-on demo, a lab tour or a career chat. Tell us what you'd like and when, and we'll put
          it in front of presenters. <strong>No account and no sign-in.</strong></p>
        <ol class="eg-how">
          <li><strong>Post it</strong> below: what you'd like, and the dates that work.</li>
          <li><strong>The McGhee Lab checks it</strong>, usually within a few days, and puts it live.</li>
          <li><strong>Presenters sign up.</strong> You accept one from your private page and email them the details.
            The page writes that email for you.</li>
        </ol>
        <p class="tc-muted" style="margin:0">Already teaching with us? You can also post from the Engagement tab of
          <a href="#/teach">your teaching dashboard</a>.</p>
      </div>
      ${myPostsHTML()}`}
      ${formHTML()}`;
    wireForm(root);
  }

  function readForm(form) {
    const val = (n) => (form.elements[n] ? form.elements[n].value : '');
    draft.name = val('name'); draft.email = val('email'); draft.phone = val('phone');
    draft.school = val('school'); draft.city = val('city'); draft.state = val('state');
    draft.schoolType = (form.querySelector('input[name=schoolType]:checked') || {}).value || '';
    draft.subject = val('subject'); draft.grade = val('grade'); draft.classSize = val('classSize');
    draft.title = val('title'); draft.topic = val('topic');
    draft.activityTypes = [...form.querySelectorAll('input[name=activityTypes]:checked')].map(i => i.value);
    draft.formats = [...form.querySelectorAll('input[name=formats]:checked')].map(i => i.value);
    draft.panel = (form.querySelector('input[name=panel]:checked') || {}).value === 'several';
    draft.presentersWanted = Number(val('presentersWanted')) || 2;
    form.querySelectorAll('.eg-daterow').forEach(row => {
      const i = Number(row.dataset.i);
      if (!draft.dates[i]) return;
      row.querySelectorAll('[data-d]').forEach(el => { draft.dates[i][el.dataset.d] = el.value; });
    });
    draft.address = val('address'); draft.room = val('room'); draft.arrivalNotes = val('arrivalNotes');
    draft.noteToLab = val('noteToLab');
    if (!editing) lsSet(LS_DRAFT, draft);
  }

  function setErr(form, name, msg) {
    const el = form.querySelector(`[data-err="${name}"]`);
    if (el) { el.textContent = msg || ''; el.hidden = !msg; }
    const holder = form.querySelector(`[data-field="${name}"]`);
    if (holder) holder.classList.toggle('is-invalid', !!msg);
  }

  // Mirrors the function's checks, field by field, so a teacher sees every
  // problem at once beside the field instead of one server message at a time.
  function validate(form) {
    const d = draft;
    const errs = {};
    const today = K().todayISO();
    if (d.name.trim().length < 2) errs.name = 'Tell us your name.';
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(d.email.trim())) errs.email = 'That email address doesn’t look right.';
    if (d.school.trim().length < 2) errs.school = 'Which school?';
    if (!d.city.trim()) errs.city = 'Which city?';
    if (!d.subject.trim()) errs.subject = 'What subject is the class?';
    if (!d.grade.trim()) errs.grade = 'Which grade(s)?';
    const n = Number(d.classSize);
    if (!Number.isInteger(n) || n < 1 || n > 500) errs.classSize = 'About how many students? (a number)';
    if (d.title.trim().length < 4) errs.title = 'Say in a few words what you’d like.';
    if (!d.activityTypes.length) errs.activityTypes = 'Tick at least one kind of visit.';
    if (!d.formats.length) errs.formats = 'Tick at least one place.';
    const seen = new Set();
    for (const x of d.dates) {
      if (!x.date) { errs.dates = 'Pick a date in every row, or remove the empty row.'; break; }
      if (x.date < today) { errs.dates = 'One of the dates has already passed.'; break; }
      if (!x.startTime || !x.endTime) { errs.dates = 'Give a start and end time for every date.'; break; }
      if (x.endTime <= x.startTime) { errs.dates = 'An end time is before its start time.'; break; }
      if (seen.has(x.date)) { errs.dates = 'The same date is listed twice.'; break; }
      seen.add(x.date);
    }
    if (d.formats.includes('at-school') && !d.address.trim()) errs.address = 'Add the street address, so a presenter you accept knows where to go.';
    ['name', 'email', 'school', 'city', 'subject', 'grade', 'classSize', 'title', 'activityTypes', 'formats', 'dates', 'address']
      .forEach(k => setErr(form, k, errs[k]));
    return errs;
  }

  function payloadOf(form) {
    const d = draft;
    return {
      name: d.name, email: d.email, phone: d.phone,
      school: d.school, schoolType: d.schoolType, city: d.city, state: d.state,
      subject: d.subject, grade: d.grade, classSize: Number(d.classSize),
      title: d.title, activityTypes: d.activityTypes, formats: d.formats, topic: d.topic,
      presentersWanted: d.panel ? d.presentersWanted : 1,
      dates: d.dates.map(x => ({ date: x.date, startTime: x.startTime, endTime: x.endTime })),
      address: d.formats.includes('at-school') ? d.address : '',
      room: d.formats.includes('at-school') ? d.room : '',
      arrivalNotes: d.formats.includes('at-school') ? d.arrivalNotes : '',
      noteToLab: d.noteToLab,
      company_url: form.elements.company_url ? form.elements.company_url.value : ''
    };
  }

  function wireForm(root) {
    const form = root.querySelector('#eg-form');
    const status = root.querySelector('#eg-form-status');
    const say = (msg, isErr) => { status.textContent = msg || ''; status.classList.toggle('error-text', !!isErr); };
    const datesBox = root.querySelector('#eg-dates');
    const paintDates = () => { datesBox.innerHTML = datesHTML(); };
    form.querySelector('[data-cancel-edit]')?.addEventListener('click', () => {
      editing = null;
      paintManage(root);
      root.scrollIntoView({ block: 'start' });
    });

    form.addEventListener('input', (ev) => {
      readForm(form);
      const holder = ev.target.closest('[data-field]');
      if (holder) setErr(form, holder.dataset.field, '');
    });
    form.addEventListener('change', (ev) => {
      readForm(form);
      if (ev.target.name === 'formats') {
        const where = form.querySelector('[data-where]');
        const on = draft.formats.includes('at-school');
        where.hidden = !on;
        const num = form.querySelector('[data-where] ~ section .eg-num');
        if (num) num.textContent = on ? '5' : '4';
      }
      if (ev.target.name === 'panel') form.querySelector('[data-panel-count]').hidden = !draft.panel;
      const holder = ev.target.closest('[data-field]');
      if (holder) setErr(form, holder.dataset.field, '');
    });
    datesBox.addEventListener('click', (ev) => {
      if (ev.target.closest('[data-d-add]')) {
        readForm(form);
        const last = draft.dates[draft.dates.length - 1] || {};
        draft.dates.push({ date: '', startTime: last.startTime || '10:00', endTime: last.endTime || '10:50' });
        paintDates();
        const inputs = datesBox.querySelectorAll('input[type=date]');
        if (inputs.length) inputs[inputs.length - 1].focus();
        if (!editing) lsSet(LS_DRAFT, draft);
      }
      const rm = ev.target.closest('[data-d-remove]');
      if (rm) {
        readForm(form);
        draft.dates.splice(Number(rm.closest('.eg-daterow').dataset.i), 1);
        paintDates();
        if (!editing) lsSet(LS_DRAFT, draft);
      }
    });

    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      readForm(form);
      const errs = validate(form);
      const keys = Object.keys(errs);
      if (keys.length) {
        say(keys.length === 1 ? 'One thing to fix above.' : `${keys.length} things to fix above.`, true);
        const first = form.querySelector('.is-invalid input, .is-invalid textarea, .is-invalid select, .is-invalid');
        if (first) { first.scrollIntoView({ block: 'center', behavior: 'smooth' }); if (first.focus) first.focus({ preventScroll: true }); }
        return;
      }
      const btn = form.querySelector('#eg-submit');
      btn.disabled = true;
      say(editing ? 'Saving…' : 'Posting…');
      try {
        if (editing) {
          // We're already ON the private page's URL, so setting the hash
          // would not re-render anything: repaint it from the saved view.
          const out = await call('update', Object.assign({ token: editing.token }, payloadOf(form)));
          TOKEN = editing.token;
          editing = null;
          V = out;
          paintManage(root, 'Saved. The McGhee Lab will review the updated post.');
          root.scrollIntoView({ block: 'start' });
          return;
        }
        const out = await call('submit', payloadOf(form));
        lsSet(LS_DRAFT, null);
        rememberPost(out.token, draft.title, draft.school);
        showPosted(root, out.token, draft);
      } catch (e) {
        btn.disabled = false;
        say(e.message, true);
      }
    });
  }

  function emailSelfHref(email, title, link) {
    return K().mailtoOf(email, `My McGhee Lab visit post: ${title}`,
      `Here's the private link to my classroom visit post:\n\n${link}\n\nOpen it to see who signed up and to accept a presenter. ` +
      `There's no account or password, so keep this email.`);
  }

  function linkBoxHTML(token, email, title) {
    const link = linkOf(token);
    return `
      <div class="eg-linkbox">
        <code class="eg-link" data-link>${esc(link)}</code>
        <div class="eg-link-actions">
          <button type="button" class="btn btn-primary btn-small" data-copy-link>Copy link</button>
          ${email ? `<a class="btn btn-secondary btn-small" href="${esc(emailSelfHref(email, title, link))}">Email it to myself</a>` : ''}
          <span class="eg-copied" aria-live="polite"></span>
        </div>
      </div>`;
  }
  function wireLinkBox(scope, token) {
    scope.querySelectorAll('[data-copy-link]').forEach(btn => btn.addEventListener('click', async () => {
      const ok = await copyText(linkOf(token));
      const note = btn.parentElement.querySelector('.eg-copied');
      if (note) note.textContent = ok ? 'Copied.' : 'Select the link above and copy it yourself.';
    }));
  }

  function showPosted(root, token, d) {
    root.innerHTML = `
      <div class="dash-header"><h2>Posted — thank you!</h2></div>
      <div class="dash-card eg-done">
        <p>The McGhee Lab will check <strong>${esc(d.title)}</strong>, usually within a few days. Once it's
          live, presenters can see it and sign up.</p>
        <h3>Your private page</h3>
        <p>Keep this link. It's how you see sign-ups and accept a presenter, and there's no account or password.
          We'll also email it to you when a presenter signs up.</p>
        ${linkBoxHTML(token, d.email, d.title)}
        <p><a class="btn btn-primary" href="${ROUTE}/${esc(token)}">Open my page</a>
           <a class="btn btn-secondary" href="${ROUTE}">Post another</a></p>
      </div>`;
    wireLinkBox(root, token);
    root.scrollIntoView({ block: 'start' });
  }

  /* ================================================================
     THE PRIVATE PAGE — #/invite-a-scientist/{token}
     ================================================================ */
  let V = null;              // the last view from the function
  let TOKEN = null;
  const emailEdits = new Map();
  const composed = new Set();

  async function showManage(root, token) {
    TOKEN = token;
    root.innerHTML = `<p class="loading-text">Loading your post…</p>`;
    try {
      V = await call('get', { token });
    } catch (e) {
      root.innerHTML = e.status === 404 ? `
        <div class="dash-header"><h2>We couldn't find that post</h2></div>
        <div class="dash-card">
          <p>${esc(e.message)}</p>
          <p>If you've lost your link, email <a href="mailto:${LAB_EMAIL}">${LAB_EMAIL}</a> and we'll send it again.</p>
          <p><a class="btn btn-primary" href="${ROUTE}">Post a visit</a></p>
        </div>` : `
        <div class="dash-header"><h2>Your visit post</h2></div>
        <div class="dash-card"><p class="error-text">${esc(e.message)}</p>
          <p><button type="button" class="btn btn-primary" data-retry>Try again</button></p></div>`;
      root.querySelector('[data-retry]')?.addEventListener('click', () => showManage(root, token));
      return;
    }
    rememberPost(token, V.post.opportunity.title, V.post.listing.school);
    paintManage(root);
  }

  function setStatus(root, msg, isErr) {
    const el = root.querySelector('#eg-status');
    if (!el) return;
    el.textContent = msg || '';
    el.className = 'teach-status' + (isErr ? ' error-text' : '');
    el.hidden = !msg;
    clearTimeout(setStatus._t);
    if (msg && !isErr) setStatus._t = setTimeout(() => { el.hidden = true; }, 5000);
  }

  function liveState() {
    const p = V.post, o = V.opportunity;
    if (p.status === 'pending') return { chip: ['tc-chip-pending', 'waiting for review'],
      text: 'The McGhee Lab checks every post before presenters see it, usually within a few days. You can still edit it until then.' };
    if (p.status === 'declined') return { chip: ['tc-chip-denied', 'not published'],
      text: 'The McGhee Lab didn’t publish this post.' + (p.labNote ? ` Their note: “${p.labNote}”` : '') };
    if (p.status === 'withdrawn') return { chip: ['tc-chip-draft', 'withdrawn'], text: 'You withdrew this post, so presenters no longer see it.' };
    if (!o) return { chip: ['tc-chip-draft', 'closed'], text: 'This post is no longer live.' };
    const today = K().todayISO();
    const ahead = (o.dates || []).some(d => d.date >= today);
    if (o.status === 'open' && !ahead) return { chip: ['tc-chip-draft', 'dates passed'],
      text: 'All of your dates have passed, so presenters no longer see it. Post again with new dates.' };
    if (o.status === 'open') return { chip: ['tc-chip-approved', 'live'],
      text: 'Live: presenters can see it and sign up. When someone does, they’ll appear below and the McGhee Lab will email you.' };
    if (o.status === 'booked') return { chip: ['tc-chip-approved', 'booked'], text: 'Booked. It’s off the sign-up list.' };
    if (o.status === 'paused') return { chip: ['tc-chip-draft', 'paused'], text: 'The McGhee Lab paused this post. Email us if that’s unexpected.' };
    return { chip: ['tc-chip-draft', 'closed'], text: 'Closed to new sign-ups.' };
  }

  function emailPartsFor(r) {
    const p = V.post, o = V.opportunity || {};
    const others = (o.acceptedRequestIds || []).filter(id => id !== r.id)
      .map(id => V.requests.find(x => x.id === id)).filter(x => x && x.status === 'confirmed');
    return K().buildVisitEmail({
      r, opp: o, others,
      loc: r.location || { ...(p.location || {}), phone: (p.teacher && p.teacher.phone) || '' },
      school: p.listing.school, teacherName: p.teacher.name,
      subject: p.listing.subject, grade: p.listing.grade, size: p.listing.classSize
    });
  }

  function emailBlockHTML(r, parts, withSent) {
    const body = emailEdits.has(r.id) ? emailEdits.get(r.id) : parts.body;
    const edited = emailEdits.has(r.id) && body !== parts.body;
    return `
      <div class="eh-email" data-email="${esc(r.id)}">
        <div class="eh-email-row"><span class="eh-email-label">To</span>
          <span class="eh-email-val">${esc(parts.to)}</span>
          <button type="button" class="btn btn-secondary btn-small" data-copy="to">Copy</button></div>
        <div class="eh-email-row"><span class="eh-email-label">Subject</span>
          <span class="eh-email-val">${esc(parts.subject)}</span>
          <button type="button" class="btn btn-secondary btn-small" data-copy="subject">Copy</button></div>
        <label class="eh-sr" for="eg-email-body-${esc(r.id)}">Email to ${esc(r.requesterName || 'the presenter')}</label>
        <textarea id="eg-email-body-${esc(r.id)}" class="eh-email-body" rows="16" data-email-body spellcheck="true">${esc(body)}</textarea>
        <div class="eh-email-actions">
          <button type="button" class="btn btn-primary btn-small" data-copy="body">Copy the email</button>
          <button type="button" class="btn btn-secondary btn-small" data-compose>Open in your email app</button>
          <button type="button" class="btn btn-secondary btn-small" data-reset-email${edited ? '' : ' hidden'}>Undo my edits</button>
          <span class="eh-email-copied" aria-live="polite"></span>
        </div>
        ${withSent ? `<p class="eh-mail-step eh-mail-sent"><span>Once it's sent, mark it here so this visit stops asking.</span>
          <button type="button" class="btn ${composed.has(r.id) ? 'btn-primary' : 'btn-secondary'} btn-small" data-mark-emailed>Yes, I sent it</button></p>` : ''}
      </div>`;
  }

  function acceptableDates(r) {
    const o = V.opportunity || {};
    const keys = o.dateKeys && o.dateKeys.length ? o.dateKeys : (o.dates || []).map(d => d.date);
    const picks = (r.dates || []).filter(d => keys.includes(d));
    const ds = o.bookedDate ? picks.filter(d => d === o.bookedDate) : picks;
    return ds.sort().map(d => ({ date: d, ...((o.dates || []).find(x => x.date === d) || {}) }));
  }

  function whoHTML(r) {
    return `<strong>${esc(r.requesterName || 'A presenter')}</strong>${r.requesterTitle || r.requesterAffiliation
      ? ` <span class="tc-muted">${esc([r.requesterTitle, r.requesterAffiliation].filter(Boolean).join(', '))}</span>` : ''}`;
  }
  const kindOf = (r) => [K().label(K().ACTIVITY_TYPES, r.activityType), K().label(K().FORMATS, r.format)].filter(Boolean).map(esc).join(' · ');

  function signupsHTML() {
    const o = V.opportunity;
    if (!o) return '';
    const fmtDay = K().fmtDay;
    const today = K().todayISO();
    const R = V.requests;
    const pending = R.filter(r => r.status === 'pending');
    const upcoming = R.filter(r => r.status === 'confirmed' && String(r.date || '') >= today);
    const past = R.filter(r => r.status === 'confirmed' && String(r.date || '') < today);
    const closed = R.filter(r => r.status === 'declined' || r.status === 'cancelled');
    const wanted = o.presentersWanted || 1;
    const full = o.status !== 'open' || (o.acceptedRequestIds || []).length >= wanted;
    return `
      <div class="dash-card eg-signups">
        <h3>Sign-ups</h3>
        ${!R.length ? `<p class="tc-muted">No sign-ups yet. When a presenter signs up, they'll appear here and the
          McGhee Lab will email you.</p>` : ''}
        ${pending.length ? `
        <div class="eh-sublist"><h5>Waiting for your answer</h5>
          ${pending.map(r => {
            const opts = acceptableDates(r);
            return `
            <div class="eh-req-row" data-req="${esc(r.id)}">
              ${whoHTML(r)}
              <span class="tc-muted eh-req-what">${kindOf(r)}${r.topic ? ' · ' + esc(r.topic) : ''}${r.okWithOthers ? ' · happy to share the session' : ''}</span>
              <span class="eh-req-dates">Could do: ${(r.dates || []).slice().sort().map(d => `<span class="eh-opening${o.bookedDate === d ? ' is-booked' : ''}">${esc(fmtDay(d))}</span>`).join('')}</span>
              ${full ? '<span class="tc-chip tc-chip-denied">this opportunity is already filled</span>' : ''}
              ${!full && o.bookedDate && !opts.length ? `<span class="tc-chip tc-chip-denied">the date is set to ${esc(fmtDay(o.bookedDate))}, which they can't do</span>` : ''}
              ${r.requesterBio ? `<p class="tc-muted">About them: ${esc(r.requesterBio)}</p>` : ''}
              ${r.message ? `<p class="tc-muted">“${esc(r.message)}”</p>` : ''}
              <div class="teach-assign-actions">
                ${!full && opts.length ? '<button type="button" class="btn btn-primary btn-small" data-open="accept">Accept…</button>' : ''}
                <button type="button" class="btn btn-secondary btn-small" data-open="decline">Decline…</button>
              </div>
              <form class="eh-decide-form" data-form="accept" hidden>
                <fieldset class="eh-choices eh-choices-inline">
                  <legend>Which date?</legend>
                  ${opts.map((d, i) => `<label class="eh-choice"><input type="radio" name="eg-pick-${esc(r.id)}" data-pick value="${esc(d.date)}"${i === 0 ? ' checked' : ''}>
                    <span><strong>${esc(fmtDay(d.date))}</strong><span class="tc-muted">${esc(d.startTime || '')}–${esc(d.endTime || '')}</span></span></label>`).join('')}
                </fieldset>
                <div class="form-group"><label for="eg-students-${esc(r.id)}">How many students should they expect?</label>
                  <input id="eg-students-${esc(r.id)}" type="number" min="1" max="500" data-students value="${esc(String(V.post.listing.classSize || ''))}"></div>
                <div class="form-group"><label for="eg-note-${esc(r.id)}">Note to the presenter <span class="tc-muted">(optional)</span></label>
                  <input id="eg-note-${esc(r.id)}" type="text" maxlength="300" data-note placeholder="e.g. park in the visitor lot, ask for me at the front office"></div>
                <p class="tc-muted">${(V.post.opportunity.formats || []).includes('at-school') && V.post.location.address
                  ? `Accepting shares the school's address with them: <strong>${esc(V.post.location.address)}</strong>${V.post.location.room ? ' · ' + esc(V.post.location.room) : ''}.`
                  : ''} Next, this page writes your email to them.</p>
                <p><button type="submit" class="btn btn-primary btn-small">Accept visit</button></p>
              </form>
              <form class="eh-decide-form" data-form="decline" hidden>
                <div class="form-group"><label for="eg-dnote-${esc(r.id)}">Note to the presenter <span class="tc-muted">(optional)</span></label>
                  <input id="eg-dnote-${esc(r.id)}" type="text" maxlength="300" data-note placeholder="e.g. we found someone for this date — thank you!"></div>
                <p><button type="submit" class="btn btn-secondary btn-small">Decline sign-up</button></p>
              </form>
            </div>`;
          }).join('')}
        </div>` : ''}
        ${upcoming.length ? `
        <div class="eh-sublist"><h5>Coming up</h5>
          ${upcoming.map(r => {
            const parts = emailPartsFor(r);
            return `
            <div class="eh-req-row${r.emailedAt ? '' : ' eh-owed'}" data-req="${esc(r.id)}">
              <strong>${esc(fmtDay(r.date))}</strong> ${esc(r.startTime || '')}–${esc(r.endTime || '')} — ${whoHTML(r)}
              <span class="tc-muted eh-req-what">${kindOf(r)}${r.expectedStudents ? ' · ' + esc(String(r.expectedStudents)) + ' students' : ''}</span>
              ${!parts
                ? `<p class="error-text">There's no email address on this sign-up. Email ${LAB_EMAIL} and we'll pass the details on.</p>`
                : r.emailedAt
                  ? `<p><span class="tc-chip tc-chip-approved">email sent ✓</span></p>
                     <details class="eh-email-again"><summary>Show the email again</summary>${emailBlockHTML(r, parts, false)}</details>`
                  : `<p class="eh-mail-step"><span class="tc-chip tc-chip-pending">email not sent yet</span>
                       <span>Your email to ${esc(r.requesterName || 'the presenter')} is ready. Copy it into a new email from
                         your own account and send it. It has everything they need: when, where, how many students, what to
                         bring and how to check in.</span></p>
                     ${emailBlockHTML(r, parts, true)}`}
              <p><button type="button" class="btn btn-secondary btn-small" data-cancel>Cancel this visit</button></p>
            </div>`;
          }).join('')}
        </div>` : ''}
        ${past.length ? `
        <div class="eh-sublist"><h5>Past visits</h5>
          ${past.map(r => `
            <div class="eh-req-row" data-req="${esc(r.id)}">
              <strong>${esc(fmtDay(r.date))}</strong> — ${whoHTML(r)}
              ${r.review ? `<div class="eh-review"><span><strong>Their review:</strong> ${esc(String(r.review.rating))}/5 overall ·
                students ${esc(String(r.review.engagement))}/5 engaged${r.review.studentsReached ? ' · ' + esc(String(r.review.studentsReached)) + ' students' : ''}</span>
                ${r.review.wentWell ? `<span class="tc-muted">Went well: ${esc(r.review.wentWell)}</span>` : ''}
                ${r.review.improve ? `<span class="tc-muted">Next time: ${esc(r.review.improve)}</span>` : ''}</div>`
                : '<span class="tc-muted">No review from them yet.</span>'}
            </div>`).join('')}
        </div>` : ''}
        ${closed.length ? `
        <details class="eg-closed"><summary>Declined or cancelled (${closed.length})</summary>
          ${closed.map(r => `<div class="eh-req-row"><span class="tc-chip tc-chip-draft">${esc(r.status)}</span> ${whoHTML(r)}
            ${r.teacherNote ? `<span class="tc-muted">“${esc(r.teacherNote)}”</span>` : ''}</div>`).join('')}
        </details>` : ''}
      </div>`;
  }

  function detailsHTML() {
    const p = V.post, o = V.opportunity;
    const kit = K();
    const op = p.opportunity;
    const dates = (o ? o.dates : op.dates) || [];
    const today = kit.todayISO();
    const wanted = (o ? o.presentersWanted : op.presentersWanted) || 1;
    return `
      <div class="dash-card eg-details">
        <h3>${esc(op.title)}</h3>
        <p class="tc-muted">${esc([p.listing.school, p.listing.city].filter(Boolean).join(', '))} ·
          ${esc([p.listing.subject, p.listing.grade && 'grade ' + p.listing.grade, p.listing.classSize && p.listing.classSize + ' students'].filter(Boolean).join(' · '))}</p>
        <p>${(op.activityTypes || []).map(a => esc(kit.label(kit.ACTIVITY_TYPES, a))).join(' · ')}
          — ${(op.formats || []).map(f => esc(kit.label(kit.FORMATS, f))).join(' / ')}
          ${wanted > 1 ? ` · up to ${wanted} presenters together` : ''}</p>
        ${op.topic ? `<p class="tc-muted">${esc(op.topic)}</p>` : ''}
        <p class="eh-req-dates">${dates.slice().sort((a, b) => a.date.localeCompare(b.date)).map(d =>
          `<span class="eh-opening${o && o.bookedDate === d.date ? ' is-booked' : ''}${d.date < today ? ' is-past' : ''}">${esc(kit.fmtDay(d.date))} ${esc(d.startTime)}–${esc(d.endTime)}</span>`).join('')}</p>
        ${p.location && p.location.address ? `<p class="tc-muted">Where visitors go (private): ${esc(p.location.address)}${p.location.room ? ' · ' + esc(p.location.room) : ''}</p>` : ''}
        <p class="tc-muted">Posted by ${esc(p.teacher.name)} · ${esc(p.teacher.email)}</p>
      </div>`;
  }

  function actionsHTML() {
    const p = V.post, o = V.opportunity;
    const bits = [];
    if (p.status === 'pending') bits.push('<button type="button" class="btn btn-secondary" data-edit>Edit the post</button>');
    if (p.status === 'published' && o && o.status === 'open' && (o.presentersWanted || 1) > 1 && (o.acceptedRequestIds || []).length) {
      bits.push('<button type="button" class="btn btn-secondary" data-enough>That’s enough presenters</button>');
    }
    if (p.status === 'pending' || (p.status === 'published' && o && ['open', 'paused', 'booked'].includes(o.status))) {
      bits.push('<button type="button" class="btn btn-secondary" data-withdraw>Withdraw the post</button>');
    }
    if (!bits.length) return `<div class="dash-card"><p style="margin:0"><a class="btn btn-primary" href="${ROUTE}">Post another visit</a></p></div>`;
    const upcomingConfirmed = V.requests.some(r => r.status === 'confirmed' && String(r.date || '') >= K().todayISO());
    return `<div class="dash-card eg-actions">
      <div class="eg-action-row">${bits.join('')}</div>
      ${upcomingConfirmed ? '<p class="tc-muted">Withdrawing keeps the visits you already accepted. Cancel those one by one above if they’re off too.</p>' : ''}
      <p class="tc-muted" style="margin-bottom:0">Need to change something on a live post? Email <a href="mailto:${LAB_EMAIL}">${LAB_EMAIL}</a>.</p>
    </div>`;
  }

  function paintManage(root, msg, isErr) {
    const st = liveState();
    const waiting = V.requests.filter(r => r.status === 'pending').length;
    const owed = V.requests.filter(r => r.status === 'confirmed' && !r.emailedAt && String(r.date || '') >= K().todayISO()).length;
    root.innerHTML = `
      <div class="dash-header"><h2>Your visit post</h2></div>
      <div id="eg-status" class="teach-status" hidden role="status" aria-live="polite"></div>
      <div class="dash-card eg-state">
        <p class="eg-state-line"><span class="tc-chip ${st.chip[0]}">${esc(st.chip[1])}</span> ${esc(st.text)}</p>
        ${waiting ? `<p><strong>${plural(waiting, 'sign-up')} waiting for your answer.</strong></p>` : ''}
        ${owed ? `<p><strong>${owed === 1 ? 'An accepted visit still needs' : owed + ' accepted visits still need'} your email to the presenter.</strong></p>` : ''}
      </div>
      <details class="dash-card eg-keep"${V.requests.length ? '' : ' open'}>
        <summary><strong>Keep this page's link</strong> <span class="tc-muted">— it's the only way back, there's no account</span></summary>
        ${linkBoxHTML(TOKEN, V.post.teacher.email, V.post.opportunity.title)}
      </details>
      ${signupsHTML()}
      ${detailsHTML()}
      ${actionsHTML()}`;
    wireLinkBox(root, TOKEN);
    wireManage(root);
    if (msg) setStatus(root, msg, isErr);
  }

  async function act(root, action, payload, okMsg) {
    try {
      const out = await call(action, Object.assign({ token: TOKEN }, payload || {}));
      V = out;
      const extra = out.declined ? ` ${plural(out.declined, 'other sign-up')} declined with a polite note.` : '';
      paintManage(root, okMsg + extra);
      return true;
    } catch (e) {
      setStatus(root, e.message, true);
      return false;
    }
  }

  function wireManage(root) {
    root.querySelectorAll('.eh-req-row [data-open]').forEach(btn => btn.addEventListener('click', () => {
      const row = btn.closest('.eh-req-row');
      row.querySelectorAll('.eh-decide-form').forEach(f => { f.hidden = f.dataset.form !== btn.dataset.open; });
      const f = row.querySelector(`.eh-decide-form[data-form="${btn.dataset.open}"]`);
      f?.querySelector('input:not([type=radio])')?.focus();
    }));
    root.querySelectorAll('.eh-decide-form[data-form="accept"]').forEach(form => form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const id = form.closest('.eh-req-row').dataset.req;
      const date = form.querySelector('[data-pick]:checked')?.value;
      const n = Number(form.querySelector('[data-students]').value);
      if (!date) { setStatus(root, 'Pick the date for the visit.', true); return; }
      if (!Number.isInteger(n) || n < 1) { setStatus(root, 'Say roughly how many students they should expect.', true); return; }
      form.querySelector('button[type=submit]').disabled = true;
      const ok = await act(root, 'decide', { requestId: id, decision: 'confirmed', date, expectedStudents: n, note: form.querySelector('[data-note]').value },
        'Accepted. Your email to the presenter is ready below: copy it and send it from your own email.');
      if (ok) root.querySelector(`.eh-email[data-email="${id}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      else form.querySelector('button[type=submit]').disabled = false;
    }));
    root.querySelectorAll('.eh-decide-form[data-form="decline"]').forEach(form => form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const id = form.closest('.eh-req-row').dataset.req;
      form.querySelector('button[type=submit]').disabled = true;
      const ok = await act(root, 'decide', { requestId: id, decision: 'declined', note: form.querySelector('[data-note]').value }, 'Sign-up declined. They’ll be told.');
      if (!ok) form.querySelector('button[type=submit]').disabled = false;
    }));

    // The confirmation email: copy, or open in the mail app; only the
    // teacher's "Yes, I sent it" records it (a mailto can't report back).
    root.querySelectorAll('.eh-email').forEach(block => {
      const id = block.dataset.email;
      const r = V.requests.find(x => x.id === id);
      const parts = r && emailPartsFor(r);
      if (!parts) return;
      const ta = block.querySelector('[data-email-body]');
      const reset = block.querySelector('[data-reset-email]');
      const note = block.querySelector('.eh-email-copied');
      const promote = () => {
        if (r.emailedAt) return;
        composed.add(id);
        const b = block.querySelector('[data-mark-emailed]');
        if (b) { b.classList.remove('btn-secondary'); b.classList.add('btn-primary'); }
      };
      ta.addEventListener('input', () => {
        if (ta.value === parts.body) emailEdits.delete(id); else emailEdits.set(id, ta.value);
        reset.hidden = ta.value === parts.body;
      });
      reset.addEventListener('click', () => { emailEdits.delete(id); ta.value = parts.body; reset.hidden = true; });
      block.querySelector('[data-compose]').addEventListener('click', () => {
        promote();
        window.location.href = K().mailtoOf(parts.to, parts.subject, ta.value);
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
        if (ok && what === 'body') promote();
      }));
    });
    root.querySelectorAll('[data-mark-emailed]').forEach(btn => btn.addEventListener('click', async () => {
      const id = btn.closest('.eh-req-row').dataset.req;
      btn.disabled = true;
      if (await act(root, 'emailed', { requestId: id }, 'Marked as sent. The presenter has everything they need.')) composed.delete(id);
      else btn.disabled = false;
    }));
    root.querySelectorAll('[data-cancel]').forEach(btn => btn.addEventListener('click', () =>
      K().armConfirm(btn, () => act(root, 'cancel', { requestId: btn.closest('.eh-req-row').dataset.req },
        'Visit cancelled. The presenter is told, and your post is open for sign-up again.'))));
    const enough = root.querySelector('[data-enough]');
    enough?.addEventListener('click', () => K().armConfirm(enough, () => act(root, 'enough', {}, 'Closed to new presenters.')));
    const withdraw = root.querySelector('[data-withdraw]');
    withdraw?.addEventListener('click', () => K().armConfirm(withdraw, () => act(root, 'withdraw', {}, 'Withdrawn. Presenters no longer see it.')));
    root.querySelector('[data-edit]')?.addEventListener('click', () => {
      showForm(root, { token: TOKEN, post: V.post });
      root.scrollIntoView({ block: 'start' });
    });
  }

  /* ================================================================
     EXPORTS
     ================================================================ */
  ML.renderGuestPage = renderGuestPage;
  ML.wireGuestPage = wireGuestPage;
})();
