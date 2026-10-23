/* meetings-live.js — the "Run meeting" view (V3.743).
 *
 * Opened from the Next-meeting card. Two columns:
 *   left  — the agenda as a TIMED checklist: planned start per block
 *           (meeting.time + cumulative minutes), a wall-clock "now" marker,
 *           an over-time chip, tick-to-complete, and a notes textarea per
 *           block that any lab member can type into;
 *   right — general notes, the action-item list with an inline quick-add
 *           that writes through to the assignee's My Week, and the deck /
 *           slides links so the presenter can open them in one tap.
 *
 * Writes are DOTTED-PATH updates (minutes.items.<id>.notes) debounced
 * 800 ms and flushed on blur, so two scribes on different blocks never
 * clobber each other — Firestore merges at the field level. A snapshot
 * never overwrites a focused textarea: meetings.js defers renders while
 * the user is typing.
 *
 * Reads only the window.MEETINGS surface published by meetings.js.
 */
(function () {
  'use strict';

  const M = () => window.MEETINGS;
  const pending = {};        // key → { timer, fn }
  let clock = null;          // setInterval handle for the wall clock
  let openedId = null;

  function esc(s) { return M().esc(s); }
  function icon(n, o) { return M().icon(n, o); }
  function nowHHMM() { const d = new Date(); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); }
  function minutesBetween(a, b) { // 'HH:MM' → b − a in minutes
    const [ah, am] = a.split(':').map(Number), [bh, bm] = b.split(':').map(Number);
    return (bh * 60 + bm) - (ah * 60 + am);
  }

  /* ─── debounced field saves ────────────────────────────────── */
  function queue(key, fn, ms) {
    if (pending[key]) clearTimeout(pending[key].timer);
    pending[key] = { fn, timer: setTimeout(() => { delete pending[key]; fn(); }, ms == null ? 800 : ms) };
  }
  function flush(key) {
    const p = pending[key];
    if (!p) return;
    clearTimeout(p.timer); delete pending[key]; p.fn();
  }
  function flushAll() { Object.keys(pending).forEach(flush); }

  /* ─── render ───────────────────────────────────────────────── */
  function render(m) {
    const A = M();
    const items = A.agendaTimed(m);
    const mins = A.minutesOf(m);
    const pres = A.presentersOf(m);
    const u = A.updatesOf(m);
    const coord = A.isCoordinator();
    const isToday = m.date === A.todayStr();
    const live = !!mins.startedAt && !mins.endedAt;
    const ended = !!mins.endedAt || m.status === 'completed';
    const now = nowHHMM();
    const end = A.addMinutes(m.time, m.duration || 60);

    const header =
      '<div class="mtg-live-bar">' +
        '<button type="button" class="mtg-btn mtg-btn-sm" data-act="live-close">' + icon('x-mark', { size: 'sm' }) + ' Back</button>' +
        '<div class="mtg-live-title"><b>' + esc(A.fmtDateLong(m.date)) + '</b><span class="mtg-muted">' + esc(A.fmtRange(m.time, m.duration)) + (m.location ? ' · ' + esc(m.location) : '') + ' · ' + esc(A.presenterNames(m)) + '</span></div>' +
        '<div class="mtg-live-clock" data-live-clock data-start="' + esc(m.time) + '" data-end="' + esc(end) + '">' + clockLabel(m.time, end, now, isToday) + '</div>' +
        '<div class="mtg-live-ctl">' +
          (ended ? '<span class="mtg-status mtg-status-done">completed</span>'
            : live ? (coord ? '<button type="button" class="mtg-btn mtg-btn-sm mtg-btn-primary" data-act="live-end" data-id="' + m.id + '">' + icon('check', { size: 'sm' }) + ' End meeting</button>' : '<span class="mtg-status mtg-status-live">live</span>')
            : '<button type="button" class="mtg-btn mtg-btn-sm mtg-btn-primary" data-act="live-start" data-id="' + m.id + '">' + icon('play', { size: 'sm' }) + ' Start</button>') +
        '</div>' +
      '</div>';

    const agenda = items.length ? '<ol class="mtg-live-agenda">' + items.map(it => {
      const mi = mins.items[it.id] || {};
      const done = !!mi.done || !!it.done;
      let phase = '';
      if (isToday && !done) {
        if (now >= it.start && now < it.end) phase = 'now';
        else if (now >= it.end) phase = 'over';
      }
      const overBy = phase === 'over' ? minutesBetween(it.end, now) : 0;
      return '<li class="mtg-lb' + (done ? ' mtg-lb-done' : '') + (phase ? ' mtg-lb-' + phase : '') + '" data-lb-start="' + esc(it.start) + '" data-lb-end="' + esc(it.end) + '" data-lb-done="' + (done ? 1 : 0) + '">' +
        '<div class="mtg-lb-head">' +
          '<label class="mtg-check"><input type="checkbox" data-act="live-check" data-id="' + m.id + '" data-item="' + esc(it.id) + '"' + (done ? ' checked' : '') + '><span></span></label>' +
          '<span class="mtg-lb-time">' + esc(A.fmtTime(it.start)) + '</span>' +
          '<span class="mtg-lb-text">' + esc(it.text) +
            (it.type === 'presentation' && A.kindOf(m) === 'standard' && pres.length ? '<small class="mtg-muted"> — ' + esc(pres.map(p => A.firstName(p.uid, p.name)).join(' & ')) + '</small>' : '') + '</span>' +
          '<span class="mtg-lb-mins">' + it.minutes + ' min</span>' +
          '<span class="mtg-lb-phase" data-lb-phase>' + (phase === 'now' ? 'now' : phase === 'over' ? overBy + ' min over' : '') + '</span>' +
        '</div>' +
        '<textarea class="mtg-lb-notes" id="live-notes-' + esc(it.id) + '" data-live="notes" data-id="' + m.id + '" data-item="' + esc(it.id) + '" rows="2" placeholder="Minutes for this block…">' + esc(mi.notes || '') + '</textarea>' +
        (mi.doneBy ? '<div class="mtg-tiny mtg-muted">✓ ' + esc(A.firstName(mi.doneBy)) + (mi.doneAt ? ' at ' + new Date(mi.doneAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '') + '</div>' : '') +
      '</li>';
    }).join('') + '</ol>'
    : '<p class="mtg-muted">No agenda on this meeting.' + (coord ? ' Add one from the Next-meeting card first.' : '') + '</p>';

    const actions = A.actionItemsOf(m);
    const rail =
      '<section class="mtg-card mtg-live-sec"><h4>' + icon('check-circle', { size: 'sm' }) + ' Action items <span class="mtg-h3-sub">→ their My Week</span></h4>' +
        (actions.length ? '<ul class="mtg-actions">' + actions.map(a =>
          '<li class="mtg-ai' + (a.status === 'done' ? ' mtg-ai-done' : '') + '"><label class="mtg-check"><input type="checkbox" data-act="ai-toggle" data-id="' + m.id + '" data-item="' + esc(a.id) + '"' + (a.status === 'done' ? ' checked' : '') + '><span></span></label>' +
          '<span class="mtg-ai-text">' + esc(a.text) + '</span>' +
          (a.assigneeUid ? '<span class="mtg-ai-who">' + A.avatar(a.assigneeUid, a.assigneeName) + ' ' + esc(A.firstName(a.assigneeUid, a.assigneeName)) + (a.taskId ? ' <i title="On their My Week">' + icon('calendar-days', { size: 'xs' }) + '</i>' : '') + '</span>' : '') +
          (a.deadline ? '<span class="mtg-ai-due">' + esc(A.fmtDateShort(a.deadline)) + '</span>' : '') +
          '<button type="button" class="mtg-iconbtn mtg-danger" data-act="ai-remove" data-id="' + m.id + '" data-item="' + esc(a.id) + '" title="Remove">' + icon('x-mark', { size: 'xs' }) + '</button></li>').join('') + '</ul>' : '') +
        '<form class="mtg-live-ai" data-form="live-ai" data-id="' + m.id + '">' +
          '<input type="text" name="text" id="live-ai-text" placeholder="＋ Action item — what needs doing?" required maxlength="200" autocomplete="off">' +
          '<div class="mtg-live-ai-row">' +
            '<select name="assignee" aria-label="Assign to"><option value="">Assign to…</option>' + A.assignees().map(x => '<option value="' + esc(x.uid) + '">' + esc(x.name || x.email) + '</option>').join('') + '</select>' +
            '<input type="date" name="deadline" value="' + esc(A.addDays(m.date, 7)) + '" aria-label="Deadline">' +
            '<button type="submit" class="mtg-btn mtg-btn-sm mtg-btn-primary">Add</button>' +
          '</div>' +
        '</form>' +
      '</section>' +
      '<section class="mtg-card mtg-live-sec"><h4>' + icon('document-text', { size: 'sm' }) + ' General notes</h4>' +
        '<textarea class="mtg-live-text" id="live-general" data-live="text" data-id="' + m.id + '" rows="8" placeholder="Anything that doesn’t belong to one block…">' + esc(mins.text || '') + '</textarea>' +
        (mins.updatedBy ? '<div class="mtg-tiny mtg-muted">Last edit ' + esc(A.firstName(mins.updatedBy)) + (mins.updatedAt ? ' · ' + new Date(mins.updatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '') + '</div>' : '') +
      '</section>' +
      ((pres.some(p => p.link) || u.deck) ? '<section class="mtg-card mtg-live-sec"><h4>' + icon('link', { size: 'sm' }) + ' Open</h4>' +
        (u.deck ? '<div class="mtg-tiny mtg-muted">Round-robin deck</div>' + window.DRIVE_LINK.card(u.deck, { compact: true }) : '') +
        pres.filter(p => p.link).map(p => '<div class="mtg-tiny mtg-muted">' + esc(A.firstName(p.uid, p.name)) + '’s slides</div>' + window.DRIVE_LINK.card(p.link, { compact: true })).join('') +
      '</section>' : '');

    return '<div class="mtg-live">' + header +
      '<div class="mtg-live-cols"><div class="mtg-live-main"><section class="mtg-card mtg-live-sec"><h4>' + icon('clipboard-document-list', { size: 'sm' }) + ' Agenda &amp; minutes <span class="mtg-h3-sub">' + A.agendaTotal(items) + ' min planned</span></h4>' + agenda + '</section></div>' +
      '<aside class="mtg-live-rail">' + rail + '</aside></div></div>';
  }

  function clockLabel(start, end, now, isToday) {
    if (!isToday) return icon('clock', { size: 'sm' }) + ' ' + M().fmtTime(now);
    const toStart = minutesBetween(now, start);
    if (toStart > 0) return icon('clock', { size: 'sm' }) + ' starts in ' + toStart + ' min';
    const over = minutesBetween(end, now);
    if (over > 0) return '<span class="mtg-over">' + icon('exclamation-triangle', { size: 'sm' }) + ' ' + over + ' min over</span>';
    return icon('clock', { size: 'sm' }) + ' ' + minutesBetween(start, now) + ' min in · ' + (-over) + ' left';
  }

  /* Ticks once a minute: updates the clock chip and the now/over markers in
   * place — no re-render, so nobody's caret moves. */
  function tick() {
    const root = document.querySelector('.mtg-live');
    if (!root) { stopClock(); return; }
    const c = root.querySelector('[data-live-clock]');
    const now = nowHHMM();
    const m = M().meeting(openedId);
    if (c && m) c.innerHTML = clockLabel(c.dataset.start, c.dataset.end, now, m.date === M().todayStr());
    if (!m || m.date !== M().todayStr()) return;
    root.querySelectorAll('.mtg-lb').forEach(li => {
      li.classList.remove('mtg-lb-now', 'mtg-lb-over');
      const ph = li.querySelector('[data-lb-phase]');
      if (li.dataset.lbDone === '1') { if (ph) ph.textContent = ''; return; }
      if (now >= li.dataset.lbStart && now < li.dataset.lbEnd) { li.classList.add('mtg-lb-now'); if (ph) ph.textContent = 'now'; }
      else if (now >= li.dataset.lbEnd) { li.classList.add('mtg-lb-over'); if (ph) ph.textContent = minutesBetween(li.dataset.lbEnd, now) + ' min over'; }
      else if (ph) ph.textContent = '';
    });
  }
  function startClock() { stopClock(); clock = setInterval(tick, 15000); }
  function stopClock() { if (clock) { clearInterval(clock); clock = null; } }

  function afterRender(liveId) {
    if (liveId) { openedId = liveId; if (!clock) startClock(); tick(); }
    else { openedId = null; stopClock(); flushAll(); }
  }

  /* ─── events (dispatched from meetings.js) ─────────────────── */
  async function onAct(act, btn) {
    const A = M();
    const id = btn.dataset.id;
    if (act === 'live-start') {
      await A.patchFields(id, { 'minutes.startedAt': A.isoNow(), 'minutes.startedBy': A.me() });
      A.toast('success', 'Meeting started — minutes are live for everyone');
    } else if (act === 'live-end') {
      flushAll();
      A.openConfirm('End the meeting and mark it completed? Minutes and action items stay editable from History.', 'End meeting', async () => {
        await A.setStatus(id, 'completed');
        A.state.ui.live = null;
        A.render();
        A.toast('success', 'Meeting completed');
      });
    }
  }

  async function onChange(el) {
    const A = M();
    if (el.dataset.act === 'live-check') {
      const done = el.checked;
      const p = {};
      p['minutes.items.' + el.dataset.item + '.done'] = done;
      p['minutes.items.' + el.dataset.item + '.doneAt'] = done ? A.isoNow() : null;
      p['minutes.items.' + el.dataset.item + '.doneBy'] = done ? A.me() : null;
      p['minutes.updatedAt'] = A.isoNow(); p['minutes.updatedBy'] = A.me();
      await A.patchFields(el.dataset.id, p);
    }
  }

  function onInput(el) {
    const A = M();
    const id = el.dataset.id;
    const value = el.value;
    if (el.dataset.live === 'notes') {
      const item = el.dataset.item;
      queue('notes:' + item, () => A.patchFields(id, {
        ['minutes.items.' + item + '.notes']: value, 'minutes.updatedAt': A.isoNow(), 'minutes.updatedBy': A.me(),
      }).catch(e => A.toast('error', 'Couldn’t save notes: ' + (e && e.message))));
      el.addEventListener('blur', () => flush('notes:' + item), { once: true });
    } else if (el.dataset.live === 'text') {
      queue('text', () => A.patchFields(id, { 'minutes.text': value, 'minutes.updatedAt': A.isoNow(), 'minutes.updatedBy': A.me() })
        .catch(e => A.toast('error', 'Couldn’t save notes: ' + (e && e.message))));
      el.addEventListener('blur', () => flush('text'), { once: true });
    }
  }

  async function onSubmit(f, fd) {
    const A = M();
    if (f.dataset.form === 'live-ai') {
      const text = String(fd.get('text') || '').trim();
      if (!text) return;
      const assignee = fd.get('assignee') || '';
      const deadline = fd.get('deadline') || null;
      f.querySelector('[name="text"]').value = '';
      await A.addActionItem(f.dataset.id, { text, assigneeUid: assignee, deadline });
      // Explicit render: focus goes straight back to the text input, and a
      // focused input DEFERS snapshot renders (so nobody's typing is eaten) —
      // without this the new row wouldn't appear until the scribe blurred.
      A.render();
      setTimeout(() => { const i = document.getElementById('live-ai-text'); if (i) i.focus(); }, 30);
    }
  }

  window.MEETINGS_LIVE = { render, afterRender, onAct, onChange, onInput, onSubmit, flushAll };
})();
