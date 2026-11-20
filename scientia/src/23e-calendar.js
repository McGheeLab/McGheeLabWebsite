/* ==========================================================================
   23e · Calendar (V4.57 — Gabe, 20 Nov: "Add a Calendar tab right before
   Tasks. The calendar should look modern and refined. […] a calendar event
   for an experiment can be linked to a note, opening it when clicking on it
   on the calendar." He chose the Day planner on the design canvas: "The
   calendar should be one piece where you can scroll through […] The calendar
   banner should freeze so that when you scroll, you can see it. Clicking on a
   free spot brings up a create event window that is simple to fill out,
   including time to add. You can click on the sorting types to single out the
   cards just for that sort.")
   - A tab before Tasks. Week and Day: each day one column, 0:00 to 24:00,
     that scrolls; the hour is sized so 12 hours (Settings) fill the visible
     height. It opens with now a third of the way down (8:00 on another week).
     The banner (day names and the all-day row) stays above the hours.
   - Events are their own records (store `events`): a title, a day, a start
     and an end in minutes, a kind (Meeting · Experiment · Other), tags, a
     project, a linked note, a repeat. Timed reminders with an end show as
     cards too; reminders, deadlines and dated tasks sit in the all-day row
     (a task's check ticks it).
   - A click on a free spot (the dashed free time, or any empty stretch) opens
     the create window there, at that time: title, day, start and end, 30 min ·
     1 h · 2 h, the sort type, a note. Enter adds it; Esc or a click outside
     cancels.
   - A card: drag it to another time or day (it lands at the time under the
     pointer, a dashed outline shows where); drag its bottom edge for its
     length; rest on it a second and it opens in place to change it; a click
     opens its note — or makes one (a meeting note, an experiment at its first
     stage, a quick note) and links it.
   - Colour by Project · Kind · Tag · Note type · Load. The legend counts what
     is shown; a click on a value singles its cards out (the rest fade), Ctrl
     or Shift adds another, a second click clears. A tag on a card shows only
     that tag's events.
   CAL: st · on() · all() · occurs(ev, day) · dayItems(day) · allDayItems(day)
   · colour(it) · legend(list) · render() · paint() · col(day) · create(…) ·
   bub(it, el) · open(it).
   Settings → Tabs & overview → Calendar (calendar, 20a).
   ========================================================================== */
const CAL = {
  PAL: { blue: '#2F64A8', teal: '#0B7268', plum: '#9B356B', amber: '#8F5600', green: '#2E7136', indigo: '#4A4DB0', red: '#A9372A', slate: '#525C69' },
  ORDER: ['blue', 'teal', 'plum', 'amber', 'green', 'indigo', 'red'],
  KINDS: { meeting: { label: 'Meeting', c: 'blue' }, experiment: { label: 'Experiment', c: 'teal' }, other: { label: 'Other', c: 'slate' } },
  BY: [['project', 'Project'], ['kind', 'Kind'], ['tag', 'Tag'], ['ntype', 'Note type'], ['load', 'Load']],
  LOAD: [[30, 'Under 30 min'], [60, '30 min – 1 h'], [120, '1 – 2 h'], [240, '2 – 4 h'], [1e9, '4 h or more']],
  NT: { exp: 'teal', notes: 'blue', lit: 'amber', syn: 'plum' },
  st: Object.assign({ view: 'week', by: 'kind' }, (() => { try { return _ls.get('calSt', {}) || {}; } catch (e) { return {}; } })(), { single: [], tag: null, day: null }),
  root: null, hpx: 50, ro: null, _t: null,
  on: () => typeof FEAT === 'undefined' || FEAT.on('calendar'),
  tn(k, d) { try { const v = FEAT.tune('calendar', k); return v == null ? d : v; } catch (e) { return d; } },
  span() { return clamp(+CAL.tn('span', '12') || 12, 6, 24); },
  wk0() { return CAL.tn('week', 'mon') === 'sun' ? 0 : 1; },
  keep() { try { _ls.set('calSt', { view: CAL.st.view, by: CAL.st.by }); } catch (e) { } },

  /* ---------------- time ---------------- */
  today: () => localDate(new Date()),
  nowMin: () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); },
  hm: m => pad(Math.floor(m / 60) % 24) + ':' + pad(m % 60),
  dur(m) { m = Math.max(0, Math.round(m)); const h = Math.floor(m / 60), r = m % 60; return h ? h + ' h' + (r ? ' ' + r : '') : r + ' min'; },
  snap: m => Math.round(m / 15) * 15,
  pm(s) { const m = String(s || '').match(/^(\d{1,2}):(\d{2})/); return m ? clamp(+m[1] * 60 + +m[2], 0, 1440) : null; },
  addD: (day, n) => localDate(addDays(parseDay(day), n)),
  weekOf(day) { const d = parseDay(day), k = (d.getDay() - CAL.wk0() + 7) % 7; return CAL.addD(day, -k); },
  days() { const a = CAL.st.day || CAL.today(); if (CAL.st.view === 'day') return [a]; const s = CAL.weekOf(a); return [0, 1, 2, 3, 4, 5, 6].map(i => CAL.addD(s, i)); },

  /* ---------------- records ---------------- */
  all: () => DB.all('events'),
  occurs(ev, day) {
    if (!ev || !ev.day || day < ev.day || (ev.until && day > ev.until) || (ev.skip || []).includes(day)) return false;
    const r = ev.repeat || 'none'; if (r === 'none') return ev.day === day; if (r === 'daily') return true;
    if (r === 'weekly') return parseDay(day).getDay() === parseDay(ev.day).getDay(); return false;
  },
  save(ev, label) { DB.beginGroup(label || 'Calendar'); ev.modified = isoLocal(new Date()); DB.put('events', ev); changed(); },
  make(o) {
    const ev = Object.assign({ id: uid('ev'), title: '', day: CAL.today(), start: 540, end: 600, allDay: false, kind: 'other', tags: [], projectId: null, docId: null, repeat: 'none', skip: [], created: isoLocal(new Date()) }, o);
    ev.title = String(ev.title || '').trim() || 'New event'; if (ev.end <= ev.start) ev.end = Math.min(1440, ev.start + 15); return ev;
  },
  /** A reminder's occurrence on `day` (repeats rolled forward), or null. */
  remOn(r, day) { try { if (!r.at || r.done) return null; const at = REM.when(r, dayStart(parseDay(day))); return localDate(at) === day ? at : null; } catch (e) { return null; } },
  /** What has a time on a day: events, and reminders with an end (a meeting). */
  dayItems(day) {
    const out = CAL.all().filter(ev => !ev.allDay && CAL.occurs(ev, day)).map(ev => ({ k: ev.id + '@' + day, ev, day, s: ev.start, e: Math.max(ev.start + 15, ev.end), title: ev.title }));
    if (typeof REM !== 'undefined') REM.all().forEach(r => { if (r.allDay || !r.end) return; const at = CAL.remOn(r, day); if (!at) return;
      const s = at.getHours() * 60 + at.getMinutes(), e = Math.min(1440, s + Math.max(15, Math.round((+new Date(r.end) - +new Date(r.at)) / 6e4)));
      out.push({ k: 'rem:' + r.id + '@' + day, rem: r, at, day, s, e, title: r.title || 'Reminder' }); });
    return out.filter(CAL.shown).sort((a, b) => a.s - b.s || b.e - a.e);
  },
  /** The all-day row: all-day events, reminders without an end (a deadline, a reminder), dated tasks. */
  allDayItems(day) {
    const out = CAL.all().filter(ev => ev.allDay && CAL.occurs(ev, day)).map(ev => ({ k: ev.id + '@' + day, ev, day, s: 0, e: 0, title: ev.title, ad: true }));
    if (typeof REM !== 'undefined') REM.all().forEach(r => { if (r.end && !r.allDay) return; if (r.taskId) return; const at = CAL.remOn(r, day); if (!at) return;
      out.push({ k: 'rem:' + r.id + '@' + day, rem: r, at, day, ad: true, title: r.title || 'Reminder', time: r.allDay ? '' : fmtTime(at) }); });
    if (typeof TASK !== 'undefined') TASK.all().forEach(b => { const d = TASK.dueAt(b); if (!d || localDate(d) !== day) return; const t = TASK.t(b);
      out.push({ k: 'task:' + b.id, task: b, day, ad: true, title: TASK.text(b) || 'Task', done: !!t.done, time: t.allDay ? '' : fmtTime(d) }); });
    return out.filter(CAL.shown);
  },
  tagsOf: it => (it.ev && it.ev.tags) || [],
  shown: it => !CAL.st.tag || CAL.tagsOf(it).includes(CAL.st.tag),

  /* ---------------- colour by ---------------- */
  kindOf: it => it.ev ? (CAL.KINDS[it.ev.kind] ? it.ev.kind : 'other') : it.rem ? 'rem' : 'task',
  docOf(it) { const id = it.ev ? it.ev.docId : it.rem ? (it.rem.noteId || it.rem.docId) : it.task ? it.task.docId : null; const d = id && M.doc(id); return d && !d.deleted ? d : null; },
  projOf(it) { const d = CAL.docOf(it); return (it.ev && it.ev.projectId) || (it.rem && it.rem.projectId) || (d && d.projectId) || null; },
  projOrder() { return DB.all('projects').slice().sort((a, b) => String(a.created || '').localeCompare(String(b.created || ''))).map(p => p.id); },
  tagOrder() { const s = new Set(); CAL.all().forEach(ev => (ev.tags || []).forEach(t => s.add(t))); return [...s].sort((a, b) => a.localeCompare(b)); },
  band(m) { return CAL.LOAD.findIndex(([x]) => m < x); },
  /** {key, label, col, ink?, cls?} — the value this item has under Colour by. */
  colour(it) {
    const P = CAL.PAL, by = CAL.st.by, kd = CAL.kindOf(it);
    if (kd === 'rem') return { key: 'rem', label: 'Reminder', col: P.amber };
    if (kd === 'task') return { key: 'task', label: 'Task', col: P.slate };
    if (by === 'project') { const id = CAL.projOf(it), i = id ? CAL.projOrder().indexOf(id) : -1, p = id && M.project(id);
      return p ? { key: 'p:' + id, label: p.name, col: P[CAL.ORDER[i]] || P.slate } : { key: 'p:', label: 'No project', col: P.slate }; }
    if (by === 'tag') { const t = CAL.tagsOf(it)[0], i = t ? CAL.tagOrder().indexOf(t) : -1; return t ? { key: 't:' + t, label: '#' + t, col: P[CAL.ORDER[i]] || P.slate } : { key: 't:', label: 'No tag', col: P.slate }; }
    if (by === 'ntype') { const d = CAL.docOf(it); if (!d) return { key: 'n:', label: 'No note', col: P.slate }; const k = typeof NOTEKIND !== 'undefined' ? NOTEKIND.of(d) : 'notes';
      return { key: 'n:' + k, label: typeof NOTEKIND !== 'undefined' ? NOTEKIND.LABEL[k] : 'Note', col: P[CAL.NT[k]] || P.blue }; }
    if (by === 'load') { const b = CAL.band(it.e - it.s); return { key: 'l:' + b, label: CAL.LOAD[b][1], col: 'var(--ld' + b + ')', ink: 'var(--ld' + b + '-ink)', cls: 'ld' + b, ord: b }; }
    return { key: 'k:' + kd, label: CAL.KINDS[kd].label, col: P[CAL.KINDS[kd].c] };
  },
  legend(list) {
    const m = new Map(); list.forEach(it => { const c = CAL.colour(it); const o = m.get(c.key) || Object.assign({ n: 0 }, c); o.n++; m.set(c.key, o); });
    const L = [...m.values()]; if (CAL.st.by === 'load') L.sort((a, b) => a.ord - b.ord); return L;
  },
  dim: it => CAL.st.single.length > 0 && !CAL.st.single.includes(CAL.colour(it).key),
  pick(key, add) { const S = CAL.st.single; const i = S.indexOf(key); CAL.st.single = add ? (i >= 0 ? S.filter(k => k !== key) : S.concat([key])) : (i >= 0 && S.length === 1 ? [] : [key]); CAL.paint(); },

  /* ---------------- the page ---------------- */
  title() {
    const D = CAL.days(), a = parseDay(D[0]), b = parseDay(D[D.length - 1]);
    if (D.length === 1) return fmtDayLong(a);
    return a.getMonth() === b.getMonth() ? `${a.getDate()} – ${b.getDate()} ${MON[b.getMonth()]} ${b.getFullYear()}` : `${fmtDay(a)} – ${fmtDay(b)} ${b.getFullYear()}`;
  },
  step(n) { const a = CAL.st.day || CAL.today(); CAL.st.day = CAL.addD(a, n * (CAL.st.view === 'day' ? 1 : 7)); CAL._scrollTo = 'keep'; CAL.paint(); },
  setView(v, day) { CAL.st.view = v; if (day) CAL.st.day = day; CAL.keep(); CAL._scrollTo = 'auto'; CAL.paint(); },
  render() { CAL.root = h('div.cal-root'); CAL._scrollTo = 'auto'; CAL.paint(); return CAL.root; },
  paint() {
    const R = CAL.root; if (!R || !R.isConnected && R.parentNode) return;
    const old = $('.cal-scroll', R), top = old ? old.scrollTop : null;
    const D = CAL.days(), items = D.flatMap(CAL.dayItems), ads = D.flatMap(CAL.allDayItems), all = items.concat(ads.filter(x => x.ev));
    R.replaceChildren(CAL.bar(all), h('div.cal-card', CAL.planner(D)));
    const sc = $('.cal-scroll', R); sc.style.setProperty('--hpx', CAL.hpx + 'px');
    if (CAL._scrollTo === 'keep' && top != null) sc.scrollTop = top; else if (CAL._scrollTo !== 'auto' && top != null) sc.scrollTop = top;
    requestAnimationFrame(() => CAL.fit(sc));
    if (CAL.ro) CAL.ro.disconnect(); if (typeof ResizeObserver !== 'undefined') { CAL.ro = new ResizeObserver(() => CAL.fit(sc, true)); CAL.ro.observe(sc); }
    try { App.setTitle('Calendar', [h('span', plural(items.filter(x => x.ev).length + ads.filter(x => x.ev).length, 'event') + (CAL.st.view === 'day' ? ' today' : ' this week'))]); } catch (e) { }
  },
  /** The hour's height: `span` hours fill what is visible under the banner. */
  fit(sc, resized) {
    if (!sc || !sc.isConnected) return; const top = $('.cal-top', sc), avail = sc.clientHeight - (top ? top.offsetHeight : 0) - 14;
    const hpx = Math.max(22, Math.round(avail / CAL.span() * 10) / 10); const was = CAL.hpx;
    if (Math.abs(hpx - was) > .4) { const mid = sc.scrollTop / Math.max(1, was); CAL.hpx = hpx; sc.style.setProperty('--hpx', hpx + 'px'); if (resized) sc.scrollTop = mid * hpx; }
    if (CAL._scrollTo === 'auto') { CAL._scrollTo = null; const D = CAL.days(), t = CAL.today(); const m = D.includes(t) ? CAL.nowMin() : 480;
      sc.scrollTop = Math.max(0, m / 60 * CAL.hpx - (D.includes(t) ? (sc.clientHeight - (top ? top.offsetHeight : 0)) / 3 : 8)); }
  },
  bar(all) {
    const v = CAL.st.view, seg = [['day', 'Day', 'D'], ['week', 'Week', 'W']];
    const L = CAL.legend(all), S = CAL.st.single;
    return h('div.cal-bar',
      h('div.cal-nav', h('button.cal-ib', { title: 'Back (←)', 'aria-label': 'Back', on: { click: () => CAL.step(-1) } }, CAL.ic('l')),
        h('button.cal-btn', { title: 'Today (T)', on: { click: () => { CAL.st.day = null; CAL._scrollTo = 'auto'; CAL.paint(); } } }, 'Today'),
        h('button.cal-ib', { title: 'Forward (→)', 'aria-label': 'Forward', on: { click: () => CAL.step(1) } }, CAL.ic('r'))),
      h('h2.cal-ttl', CAL.title()),
      h('div.cal-seg', { role: 'group', 'aria-label': 'View' }, seg.map(([k, l, key]) => h('button' + (v === k ? '.on' : ''), { title: l + ' (' + key + ')', 'aria-pressed': String(v === k), on: { click: () => CAL.setView(k) } }, l))),
      h('span.cal-sp'),
      h('label.cal-by', h('span', 'Colour by'), h('select', { on: { change: e => { CAL.st.by = e.target.value; CAL.st.single = []; CAL.keep(); CAL.paint(); } } }, CAL.BY.map(([k, l]) => h('option', { value: k, selected: CAL.st.by === k }, l)))),
      h('div.cal-lg', L.map(o => h('button.cal-lgv' + (S.includes(o.key) ? '.on' : '') + (S.length && !S.includes(o.key) ? '.off' : ''), { title: 'Single out ' + o.label + ' (Ctrl or Shift adds another)', 'aria-pressed': String(S.includes(o.key)), on: { click: e => CAL.pick(o.key, e.ctrlKey || e.metaKey || e.shiftKey) } },
        h('i', { style: { background: o.col } }), h('span', o.label), h('b', String(o.n))))),
      S.length ? h('span.cal-chip', 'Showing: ' + L.filter(o => S.includes(o.key)).map(o => o.label).join(', '), h('button', { on: { click: () => { CAL.st.single = []; CAL.paint(); } } }, 'Clear')) : null,
      CAL.st.tag ? h('span.cal-chip', 'Only #' + CAL.st.tag, h('button', { 'aria-label': 'Show every event', on: { click: () => { CAL.st.tag = null; CAL.paint(); } } }, '×')) : null,
      h('button.cal-btn.pri', { title: 'A new event (N)', on: { click: e => { const d = CAL.days().includes(CAL.today()) ? CAL.today() : CAL.days()[0]; const r = e.currentTarget.getBoundingClientRect(); CAL.create({ day: d, start: CAL.snap(Math.min(1380, CAL.nowMin() + 30)), x: r.left - 300, y: r.bottom + 8 }); } } }, '＋ New'));
  },
  ic(k) {
    const P = { l: 'M15 18l-6-6 6-6', r: 'M9 6l6 6-6 6', x: 'M6 6l12 12M18 6 6 18', ck: 'M20 6 9 17l-5-5', bell: 'M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15zM10 20.5h4', note: 'M7 3h7l5 5v13H7zM14 3v5h5', rep: 'M17 2l4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3' };
    return h('span.cal-i', { html: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${P[k]}"/></svg>` });
  },
  planner(D) {
    const t = CAL.today(), n = CAL.span();
    const heads = D.map(day => { const d = parseDay(day), it = CAL.dayItems(day), mins = it.reduce((a, x) => a + (x.e - x.s), 0);
      return h('button.cal-dh' + (day === t ? '.today' : '') + (day < t ? '.past' : ''), { title: 'Open ' + fmtDayLong(d) + (CAL.st.view === 'day' ? '' : ' as a day'), on: { click: () => CAL.setView('day', day) } },
        h('span.dw', DOW[d.getDay()]), h('span.dn', String(d.getDate())), mins ? h('span.dl', (Math.round(mins / 6) / 10) + ' h') : null); });
    const adc = D.map(day => h('div.cal-adc', { 'data-day': day, on: { click: e => { if (e.target.closest('.cal-ad')) return; const r = e.currentTarget.getBoundingClientRect(); CAL.create({ day, allDay: true, x: r.left, y: r.bottom + 6 }); } } },
      CAL.allDayItems(day).map(CAL.adEl)));
    return h('div.cal-scroll' + (D.length === 1 ? '.one' : ''), { 'data-span': n },
      h('div.cal-top', h('div.cal-row', h('div.cal-gut', D.length > 1 ? 'W' + isoWeekNo(parseDay(D[3] || D[0])) : ''), h('div.cal-cells', heads)),
        h('div.cal-row.cal-adr', h('div.cal-gut', 'all day'), h('div.cal-cells', adc))),
      h('div.cal-body', h('div.cal-times', { 'aria-hidden': 'true' }, Array.from({ length: 23 }, (_, i) => h('span', { style: { top: `calc(var(--hpx) * ${i + 1})` } }, pad(i + 1) + ':00'))),
        h('div.cal-grid', { on: { click: CAL.gridClick, pointerdown: CAL.down } }, D.map(CAL.col))));
  },
  /** One day's column: the free time, the cards, now. */
  col(day) {
    const list = CAL.dayItems(day), lanes = CAL.lanes(list), t = CAL.today();
    const el = h('div.cal-col' + (day === t ? '.today' : '') + (day < t ? '.past' : ''), { 'data-day': day });
    if (CAL.tn('slots', true) !== false) CAL.frees(list).forEach(([s, e]) => el.append(h('button.cal-slot', { tabindex: '-1', 'data-s': s, style: { top: `calc(var(--hpx) * ${s / 60} + 2px)`, height: `calc(var(--hpx) * ${(e - s) / 60} - 4px)` }, title: 'Free ' + CAL.hm(s) + '–' + CAL.hm(e) + ' — click to add an event' },
      e - s >= 45 ? h('span', 'Free') : null, e - s >= 30 ? h('b', CAL.dur(e - s)) : null)));
    list.forEach(it => el.append(CAL.card(it, lanes.get(it.k))));
    if (day === t) el.append(h('div.cal-now', { style: { top: `calc(var(--hpx) * ${CAL.nowMin() / 60})` } }));
    return el;
  },
  lanes(list) {
    const out = new Map(); let group = [], end = -1;
    const flush = () => { const cols = []; group.forEach(it => { let c = cols.findIndex(e => e <= it.s); if (c < 0) { c = cols.length; cols.push(0); } cols[c] = it.e; out.set(it.k, { c, n: 0 }); }); group.forEach(it => { out.get(it.k).n = cols.length; }); group = []; };
    list.forEach(it => { if (it.s >= end && group.length) flush(); group.push(it); end = Math.max(end, it.e); }); if (group.length) flush(); return out;
  },
  /** The free time between cards (7:00–21:00), and a short one (2 h at most) before the first or after the last. */
  frees(list) {
    const a = 7 * 60, b = 21 * 60, L = list.slice().sort((x, y) => x.s - y.s), out = []; if (!L.length) return out; let t = null;
    L.forEach(it => { if (t != null && it.s - t >= 15) out.push([t, it.s]); t = t == null ? it.e : Math.max(t, it.e); });
    if (L[0].s - a >= 15 && L[0].s - a <= 120) out.unshift([a, L[0].s]); if (b - t >= 15 && b - t <= 120) out.push([t, b]);
    return out.map(([s, e]) => [Math.max(s, a), Math.min(e, b)]).filter(([s, e]) => e - s >= 15);
  },
  card(it, ln = { c: 0, n: 1 }) {
    const c = CAL.colour(it), len = it.e - it.s, short = len * CAL.hpx / 60 < 44, ev = it.ev, w = 100 / ln.n;
    const el = h('div.cal-ec' + (short ? '.short' : '') + (it.rem ? '.rem' : '') + (c.cls ? '.' + c.cls : '') + (CAL.dim(it) ? '.dim' : '') + (ev && !CAL.docOf(it) ? '.nonote' : '') + (ln.n > 1 ? '.conf' : ''),
      { 'data-k': it.k, style: { '--ecol': c.col, color: c.ink || null, top: `calc(var(--hpx) * ${it.s / 60} + 2px)`, height: `max(20px, calc(var(--hpx) * ${len / 60} - 4px))`, left: `calc(${ln.c * w}% + 3px)`, width: `calc(${w}% - 6px)` },
        on: { pointerenter: e => CAL.hovIn(it, e.currentTarget), pointerleave: () => CAL.hovOut() } },
      h('button.ec-main', { 'aria-label': `${it.title}, ${CAL.hm(it.s)}–${CAL.hm(it.e)}${CAL.docOf(it) ? ', opens its note' : ''}`, on: { click: e => { if (CAL._dragged) return; e.stopPropagation(); CAL.open(it); }, keydown: e => { if (e.key === 'e' || e.key === 'E') { e.preventDefault(); CAL.bub(it, el); } } } },
        h('span.ec-time', CAL.hm(it.s) + '–' + CAL.hm(it.e) + (CAL.st.by === 'load' ? ' · ' + CAL.dur(len) : '')), h('span.ec-t', it.title)),
      ev && (ev.tags || []).length && !short ? h('span.ec-tags', ev.tags.map(t => h('button.ec-tag', { title: 'Show only #' + t, on: { pointerdown: e => e.stopPropagation(), click: e => { e.stopPropagation(); CAL.st.tag = CAL.st.tag === t ? null : t; CAL.paint(); } } }, '#' + t))) : null,
      h('span.ec-ic', ev && ev.repeat && ev.repeat !== 'none' ? CAL.ic('rep') : null, CAL.docOf(it) ? CAL.ic('note') : null, it.rem ? CAL.ic('bell') : null),
      ln.n > 1 && !short ? h('span.ec-conf', 'Overlaps') : null,
      ev ? h('span.ec-rz', { 'aria-hidden': 'true' }) : null);
    return el;
  },
  adEl(it) {
    const c = CAL.colour(it);
    return h('div.cal-ad' + (it.task ? '.task' : it.rem ? '.rem' : '') + (it.done ? '.done' : '') + (CAL.dim(it) ? '.dim' : ''), { 'data-k': it.k, style: { '--ecol': c.col }, on: it.ev ? { pointerenter: e => CAL.hovIn(it, e.currentTarget), pointerleave: () => CAL.hovOut() } : {} },
      it.task ? h('button.adck', { 'aria-pressed': String(!!it.done), 'aria-label': 'Done: ' + it.title, on: { click: e => { e.stopPropagation(); TASK.toggle(it.task); } } }, it.done ? CAL.ic('ck') : null) : it.rem ? CAL.ic('bell') : null,
      h('button.adm', { title: it.title + (it.time ? ' · ' + it.time : ''), on: { click: e => { e.stopPropagation(); CAL.open(it); } } }, it.time ? h('b', it.time) : null, it.title));
  },

  /* ---------------- gestures ---------------- */
  minAt(colEl, y) { const r = colEl.getBoundingClientRect(); return clamp((y - r.top) / CAL.hpx * 60, 0, 1440); },
  colAt(x, y) { const els = document.elementsFromPoint(x, y); return els.find(e => e.classList && e.classList.contains('cal-col')) || null; },
  gridClick(e) {
    if (CAL._swallow || CAL._dragged) { CAL._swallow = false; return; }
    if (e.target.closest('.cal-ec, .cal-run')) return;
    const col = e.target.closest('.cal-col'); if (!col) return;
    const m = Math.min(1425, Math.floor(CAL.minAt(col, e.clientY) / 15) * 15);
    CAL.create({ day: col.dataset.day, start: m, x: e.clientX, y: e.clientY });
  },
  down(e) {
    if (e.button !== 0) return; const card = e.target.closest('.cal-ec'); if (!card) return;
    const it = CAL.find(card.dataset.k); if (!it || !it.ev) return;
    const rz = !!e.target.closest('.ec-rz'), col = card.closest('.cal-col'), x0 = e.clientX, y0 = e.clientY, grab = CAL.minAt(col, y0) - it.s;
    let moving = false, ghost = null, tgt = null;
    const mv = ev => {
      if (!moving && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 5) return;
      if (!moving) { moving = true; CAL.hovOut(true); card.classList.add('drag'); document.body.classList.add('cal-dragging'); }
      const c = rz ? col : CAL.colAt(ev.clientX, ev.clientY) || col; let s = it.s, en = it.e;
      if (rz) en = Math.max(it.s + 15, Math.min(1440, CAL.snap(CAL.minAt(col, ev.clientY))));
      else { s = clamp(CAL.snap(CAL.minAt(c, ev.clientY) - grab), 0, 1440 - (it.e - it.s)); en = s + (it.e - it.s); }
      tgt = { day: c.dataset.day, s, e: en };
      if (!ghost || ghost.parentNode !== c) { if (ghost) ghost.remove(); ghost = h('div.cal-ghost'); c.append(ghost); }
      ghost.style.top = `calc(var(--hpx) * ${s / 60} + 2px)`; ghost.style.height = `calc(var(--hpx) * ${(en - s) / 60} - 4px)`; ghost.textContent = CAL.hm(s) + '–' + CAL.hm(en);
    };
    const up = () => {
      removeEventListener('pointermove', mv); removeEventListener('pointerup', up); removeEventListener('pointercancel', up); document.body.classList.remove('cal-dragging');
      if (ghost) ghost.remove(); card.classList.remove('drag'); if (!moving || !tgt) return;
      CAL._dragged = true; setTimeout(() => { CAL._dragged = false; }, 0);
      if (tgt.day === it.day && tgt.s === it.s && tgt.e === it.e) return;
      CAL.moveTo(it, tgt.day, tgt.s, tgt.e, rz ? 'Length' : 'Move');
    };
    addEventListener('pointermove', mv); addEventListener('pointerup', up); addEventListener('pointercancel', up);
  },
  /** Move one occurrence: a one-off moves; one of a repeat leaves the series (the series skips that day). */
  moveTo(it, day, s, e, label) {
    const ev = it.ev; DB.beginGroup(label);
    if (ev.repeat && ev.repeat !== 'none') {
      const copy = CAL.make(Object.assign(JSON.parse(JSON.stringify(ev)), { id: uid('ev'), day, start: s, end: e, repeat: 'none', skip: [], until: null, from: ev.id, created: isoLocal(new Date()) }));
      ev.skip = (ev.skip || []).concat([it.day]); ev.modified = isoLocal(new Date()); DB.put('events', ev); DB.put('events', copy); changed(); toast('Moved this one; the others stay — Ctrl+Z undoes it', 2600); return;
    }
    Object.assign(ev, { day, start: s, end: e, modified: isoLocal(new Date()) }); DB.put('events', ev); changed();
  },
  find(k) { if (!k) return null; const day = k.split('@')[1]; const L = day ? CAL.dayItems(day).concat(CAL.allDayItems(day)) : CAL.days().flatMap(CAL.allDayItems); return L.find(x => x.k === k) || null; },

  /* ---------------- opening ---------------- */
  /** A click: its note — or a note made for it and linked (a meeting note, an experiment's first stage, a quick note). */
  open(it) {
    CAL.closeAll();
    if (it.task) return App.openBlock(it.task.id);
    if (it.rem) { if (it.rem.kind === 'meeting' && REM.meetingNote) return REM.meetingNote(it.rem, it.at); return REM.edit({ id: it.rem.id }); }
    const ev = it.ev, d = CAL.docOf(it), rep = ev.repeat && ev.repeat !== 'none';
    const mine = rep ? (ev.notes || {})[it.day] : null, md = mine && M.doc(mine);
    if (md && !md.deleted) return App.go('#/doc/' + md.id);
    if (d && !rep) return App.go('#/doc/' + d.id);
    const link = doc => { DB.beginGroup('Note for ' + ev.title); if (rep) { ev.notes = Object.assign({}, ev.notes, { [it.day]: doc.id }); } else ev.docId = doc.id; doc.eventId = ev.id; DB.put('documents', doc); ev.modified = isoLocal(new Date()); DB.put('events', ev); changed(); };
    const theme = pid => (DB.where('themes', t => t.projectId === pid && t.status === 'active')[0] || {}).id || null;
    const kind = ev.kind, title = ev.title, pid = ev.projectId;
    if (kind === 'experiment' && typeof CHAIN !== 'undefined') {
      if (pid) { const doc = CHAIN.create({ projectId: pid, themeId: theme(pid), name: title, date: it.day }); link(doc); toast('An experiment for “' + title + '”, at ' + (prof(doc.type) || {}).label + ' — Ctrl+Z undoes it', 2800); return App.go('#/doc/' + doc.id); }
      return App.newDoc({ type: CHAIN.firstType(), title, date: it.day, onCreate: doc => { doc.chain = doc.id; doc.chainName = title; link(doc); } });
    }
    const type = kind === 'meeting' ? 'meeting' : 'note', tpl = M.enabledTemplates(type)[0], ttl = kind === 'meeting' ? title + ' — ' + fmtDay(parseDay(it.day)) : title;
    if (pid) { const doc = M.createDoc({ type, projectId: pid, themeId: theme(pid), title: ttl, templateId: tpl ? tpl.id : null, date: it.day }); link(doc); toast((kind === 'meeting' ? 'A meeting note' : 'A note') + ' for “' + title + '” — Ctrl+Z undoes it', 2600); return App.go('#/doc/' + doc.id); }
    App.newDoc({ type, title: ttl, date: it.day, onCreate: link });
  },

  /* ---------------- the create window ---------------- */
  create(o) {
    CAL.closeAll(); const by = CAL.st.by, P = CAL.PAL;
    const st = { title: '', day: o.day || CAL.today(), s: o.start != null ? o.start : 540, e: null, allDay: !!o.allDay, kind: 'other', projectId: null, tag: '', docId: null };
    st.e = Math.min(1440, st.s + 60);
    const win = h('div.cal-cw', { role: 'dialog', 'aria-label': 'A new event' });
    const ti = h('input.cw-title', { placeholder: 'What is it?', 'aria-label': 'Title', autocomplete: 'off' });
    const dayI = h('input.cw-in', { type: 'date', value: st.day, 'aria-label': 'Day', on: { change: e => { if (e.target.value) st.day = e.target.value; when(); } } });
    const sI = h('input.cw-in', { type: 'time', step: 900, value: CAL.hm(st.s), 'aria-label': 'Start', on: { change: e => { const m = CAL.pm(e.target.value); if (m == null) return; const len = st.e - st.s; st.s = m; st.e = Math.min(1440, m + len); eI.value = CAL.hm(st.e % 1440); when(); } } });
    const eI = h('input.cw-in', { type: 'time', step: 900, value: CAL.hm(st.e % 1440), 'aria-label': 'End', on: { change: e => { let m = CAL.pm(e.target.value); if (m == null) return; if (m === 0) m = 1440; st.e = Math.max(st.s + 15, m); when(); } } });
    const wh = h('span.cw-when'); const when = () => { wh.textContent = fmtDayLong(parseDay(st.day)) + (st.allDay ? ' · all day' : ' · ' + CAL.hm(st.s) + '–' + CAL.hm(st.e) + ' · ' + CAL.dur(st.e - st.s)); durs.forEach(b => b.classList.toggle('on', st.e - st.s === +b.dataset.m)); tr.hidden = st.allDay; };
    const durs = [[30, '30 min'], [60, '1 h'], [120, '2 h']].map(([m, l]) => h('button.cw-d', { type: 'button', 'data-m': m, on: { click: () => { st.e = Math.min(1440, st.s + m); eI.value = CAL.hm(st.e % 1440); when(); } } }, l));
    const adB = h('label.cw-ad', h('input', { type: 'checkbox', checked: st.allDay, on: { change: e => { st.allDay = e.target.checked; when(); } } }), 'All day');
    const tr = h('div.cw-r', h('span.cw-k', 'Time'), h('div.cw-tm', h('div.cw-times', sI, h('span', '–'), eI), h('div.cw-durs', durs)));
    // the sort type: whatever Colour by is set to (a kind for Note type and Load, which the note and the length decide)
    const chips = (vals, cur, set) => h('div.cw-chips', vals.map(([v, l, col]) => h('button.cw-c' + (cur() === v ? '.on' : ''), { type: 'button', style: { '--ecol': col }, on: { click: e => { set(v); $$('.cw-c', e.currentTarget.parentNode).forEach(b => b.classList.toggle('on', b === e.currentTarget)); } } }, h('i'), l)));
    let sort;
    if (by === 'project') { const ord = CAL.projOrder(); sort = h('div.cw-r.top', h('span.cw-k', 'Project'), chips([['', 'None', P.slate]].concat(ord.slice(0, 8).map((id, i) => [id, (M.project(id) || {}).name || '?', P[CAL.ORDER[i]] || P.slate])), () => st.projectId || '', v => { st.projectId = v || null; })); }
    else if (by === 'tag') { const tg = h('input.cw-in', { placeholder: '#tag', 'aria-label': 'Tag', list: 'cal-tags', on: { input: e => { st.tag = e.target.value.replace(/^#/, '').trim(); } } }); sort = h('div.cw-r', h('span.cw-k', 'Tag'), h('div', tg, h('datalist#cal-tags', CAL.tagOrder().map(t => h('option', { value: t }))))); }
    else sort = h('div.cw-r.top', h('span.cw-k', 'Kind'), chips(Object.entries(CAL.KINDS).map(([k, o]) => [k, o.label, P[o.c]]), () => st.kind, v => { st.kind = v; }));
    const note = CAL.notePick(() => st.docId, id => { st.docId = id; });
    const go = () => {
      const ev = CAL.make({ title: ti.value, day: st.day, start: st.allDay ? 0 : st.s, end: st.allDay ? 0 : st.e, allDay: st.allDay, kind: st.kind, projectId: st.projectId || (st.docId && (M.doc(st.docId) || {}).projectId) || null, tags: st.tag ? [st.tag] : [], docId: st.docId });
      if (st.allDay) ev.end = 0; CAL.close(); DB.beginGroup('New event'); DB.put('events', ev); changed(); toast('“' + ev.title + '” added — Ctrl+Z undoes it', 2200);
    };
    win.append(h('div.cw-h', h('b', 'New event'), wh, h('button.cal-ib.sm', { type: 'button', 'aria-label': 'Cancel (Esc)', on: { click: () => CAL.close() } }, CAL.ic('x'))),
      ti, h('div.cw-r', h('span.cw-k', 'Day'), h('div.cw-dayr', dayI, adB)), tr, sort, note.el,
      h('div.cw-f', h('span.cw-hint', 'Enter adds · Esc cancels'), h('button.cal-btn.pri', { type: 'button', on: { click: go } }, 'Create')));
    win.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); CAL.close(); } else if (e.key === 'Enter' && !e.target.closest('.cw-np') && e.target.tagName !== 'BUTTON') { e.preventDefault(); go(); } });
    win.addEventListener('mousedown', e => e.stopPropagation());
    document.body.append(win); when();
    const r = win.getBoundingClientRect(); win.style.left = clamp((o.x || 200) + 14, 8, innerWidth - r.width - 8) + 'px'; win.style.top = clamp((o.y || 120) - 24, 8, innerHeight - r.height - 8) + 'px';
    CAL.cw = win; setTimeout(() => ti.focus(), 20);
    if (o.day) { const g = $(`.cal-col[data-day="${o.day}"]`, CAL.root || document); if (g && !st.allDay) { const dr = h('div.cal-draft', { style: { top: `calc(var(--hpx) * ${st.s / 60} + 2px)`, height: `calc(var(--hpx) * 1 - 4px)` } }); g.append(dr); win._draft = dr; } }
  },
  /** A note to link: type to find one; its chip, × unlinks. */
  notePick(get, set, label = 'Note') {
    const q = h('input.cw-in', { placeholder: 'Link a note (optional)', 'aria-label': 'Link a note', autocomplete: 'off' }), list = h('div.cw-nl'), chip = h('div.cw-nc');
    const draw = () => { const id = get(), d = id && M.doc(id); chip.replaceChildren(d ? [h('span', CAL.ic('note'), d.title), h('button', { type: 'button', 'aria-label': 'Unlink', on: { click: () => { set(null); draw(); } } }, '×')] : []); q.hidden = !!d; chip.hidden = !d; };
    const find = () => { const s = q.value.trim().toLowerCase(); if (!s) return list.replaceChildren();
      const ds = DB.where('documents', d => !d.deleted && !d.archived && d.type !== 'day' && String(d.title || '').toLowerCase().includes(s)).sort((a, b) => String(b.modified || '').localeCompare(String(a.modified || ''))).slice(0, 6);
      list.replaceChildren(ds.length ? ds.map(d => h('button.cw-np', { type: 'button', on: { click: () => { set(d.id); q.value = ''; list.replaceChildren(); draw(); } } }, h('b', d.title), h('span', M.docPath ? M.docPath(d) : ''))) : h('span.cw-none', 'No note by that name')); };
    q.addEventListener('input', find); q.addEventListener('keydown', e => { if (e.key === 'Enter') { const b = $('.cw-np', list); if (b) { e.preventDefault(); e.stopPropagation(); b.click(); } } });
    draw(); return { el: h('div.cw-r.top', h('span.cw-k', label), h('div.cw-note', chip, q, list)), draw };
  },

  /* ---------------- rest on a card: it opens in place ---------------- */
  hovIn(it, el) { if (document.body.classList.contains('cal-dragging') || CAL.cw) return; clearTimeout(CAL._ho); clearTimeout(CAL._hc); if (CAL.bubEl && CAL.bubEl._k === it.k) return; CAL._ho = setTimeout(() => { if (el.isConnected && el.matches(':hover')) CAL.bub(it, el); }, 950); },
  hovOut(now) { clearTimeout(CAL._ho); if (!CAL.bubEl) return; if (now) return CAL.closeBub(); clearTimeout(CAL._hc); CAL._hc = setTimeout(() => { const b = CAL.bubEl; if (b && !b.matches(':hover') && !b.contains(document.activeElement)) CAL.closeBub(); }, 320); },
  closeBub() { clearTimeout(CAL._hc); if (CAL.bubEl) { CAL.bubEl.remove(); CAL.bubEl = null; } },
  bub(it, el) {
    if (!it.ev) return; CAL.closeBub(); const r = el.getBoundingClientRect();
    const b = h('div.cal-bub', { role: 'dialog', 'aria-label': it.title, on: { pointerleave: () => CAL.hovOut(), pointerenter: () => clearTimeout(CAL._hc), mousedown: e => e.stopPropagation() } }); b._k = it.k; b._it = it;
    b.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); CAL.closeBub(); } });
    document.body.append(b); CAL.bubEl = b; CAL.bubFill(); const w = Math.max(r.width, 300), bh = b.offsetHeight;
    b.style.width = w + 'px'; b.style.left = clamp(r.left, 8, innerWidth - w - 8) + 'px'; b.style.top = clamp(r.top, 8, innerHeight - bh - 8) + 'px';
  },
  bubFill() {
    const b = CAL.bubEl; if (!b) return; const it = CAL.find(b._k) || b._it, ev = it.ev && CAL.all().find(x => x.id === it.ev.id); if (!ev) return CAL.closeBub();
    const c = CAL.colour(it), P = CAL.PAL, rep = ev.repeat && ev.repeat !== 'none';
    const upd = (f, label) => { f(ev); CAL.save(ev, label); setTimeout(() => CAL.bubFill(), 0); };
    const nud = (ds, de) => upd(x => { if (x.allDay) return; const len = x.end - x.start; x.start = clamp(x.start + ds, 0, 1440 - Math.max(15, len + de)); x.end = clamp(x.start + len + de, x.start + 15, 1440); }, 'Time');
    const ti = h('input.bub-title', { value: ev.title, 'aria-label': 'Title', on: { change: e => upd(x => { x.title = e.target.value.trim() || x.title; }, 'Title'), keydown: e => { if (e.key === 'Enter') e.target.blur(); } } });
    const tagI = h('input.bub-tagin', { placeholder: '+ tag', 'aria-label': 'Add a tag', on: { keydown: e => { if (e.key === 'Enter') { const t = e.target.value.replace(/^#/, '').trim(); if (t) upd(x => { x.tags = [...new Set((x.tags || []).concat([t]))]; }, 'Tag'); } } } });
    const note = CAL.notePick(() => ev.docId, id => upd(x => { x.docId = id; if (id && !x.projectId) x.projectId = (M.doc(id) || {}).projectId || null; }, 'Note'));
    b.replaceChildren(
      h('div.bub-top', { style: { '--ecol': c.col, color: c.ink || null } }, ti, h('span.bub-when', fmtDayLong(parseDay(it.day)) + (ev.allDay ? ' · all day' : ' · ' + CAL.hm(ev.start) + '–' + CAL.hm(ev.end)))),
      ev.allDay ? null : h('div.bub-r', h('span.cw-k', 'Time'), h('div.bub-st', h('button.cw-d', { type: 'button', on: { click: () => nud(-15, 0) } }, '−15'), h('b', CAL.hm(ev.start)), h('button.cw-d', { type: 'button', on: { click: () => nud(15, 0) } }, '+15'))),
      ev.allDay ? null : h('div.bub-r', h('span.cw-k', 'Length'), h('div.bub-st', h('button.cw-d', { type: 'button', on: { click: () => nud(0, -15) } }, '−15'), h('b', CAL.dur(ev.end - ev.start)), h('button.cw-d', { type: 'button', on: { click: () => nud(0, 15) } }, '+15'))),
      h('div.bub-r', h('span.cw-k', 'Kind'), h('div.cw-chips', Object.entries(CAL.KINDS).map(([k, o]) => h('button.cw-c' + (ev.kind === k ? '.on' : ''), { type: 'button', style: { '--ecol': P[o.c] }, on: { click: () => upd(x => { x.kind = k; }, 'Kind') } }, h('i'), o.label)))),
      h('div.bub-r', h('span.cw-k', 'Tags'), h('div.bub-tags', (ev.tags || []).map(t => h('span.bub-tag', '#' + t, h('button', { type: 'button', 'aria-label': 'Take off #' + t, on: { click: () => upd(x => { x.tags = (x.tags || []).filter(y => y !== t); }, 'Tag') } }, '×'))), tagI)),
      h('div.bub-r', h('span.cw-k', 'Project'), h('select.cw-in', { 'aria-label': 'Project', on: { change: e => upd(x => { x.projectId = e.target.value || null; }, 'Project') } }, h('option', { value: '' }, 'None'), DB.all('projects').map(p => h('option', { value: p.id, selected: ev.projectId === p.id }, p.name)))),
      note.el,
      h('div.bub-r', h('span.cw-k', 'Repeat'), h('select.cw-in', { 'aria-label': 'Repeat', on: { change: e => upd(x => { x.repeat = e.target.value; }, 'Repeat') } }, [['none', 'Does not repeat'], ['daily', 'Every day'], ['weekly', 'Every week']].map(([k, l]) => h('option', { value: k, selected: (ev.repeat || 'none') === k }, l)))),
      rep ? h('div.bub-note', 'Changes here change every one; dragging moves only this one.') : null,
      h('div.bub-f', h('button.cal-btn', { type: 'button', on: { click: () => CAL.open(it) } }, CAL.docOf(it) ? 'Open its note' : 'Make its note'),
        h('span.cal-sp'),
        h('button.cal-btn', { type: 'button', on: { click: () => { const cp = CAL.make(Object.assign(JSON.parse(JSON.stringify(ev)), { id: uid('ev'), day: it.day, repeat: 'none', skip: [], notes: null, docId: null, created: isoLocal(new Date()) })); DB.beginGroup('Duplicate'); DB.put('events', cp); changed(); CAL.closeBub(); toast('Duplicated'); } } }, 'Duplicate'),
        rep ? h('button.cal-btn', { type: 'button', on: { click: () => { CAL.closeBub(); ev.skip = (ev.skip || []).concat([it.day]); CAL.save(ev, 'Delete one'); toast('This one deleted — Ctrl+Z undoes it'); } } }, 'Delete this one') : null,
        h('button.cal-btn.danger', { type: 'button', on: { click: () => { CAL.closeBub(); DB.beginGroup('Delete event'); DB.del('events', ev.id); changed(); toast((rep ? 'Every one deleted' : 'Deleted') + ' — Ctrl+Z undoes it'); } } }, rep ? 'Delete every one' : 'Delete')));
  },
  close() { if (CAL.cw) { if (CAL.cw._draft) CAL.cw._draft.remove(); CAL.cw.remove(); CAL.cw = null; } },
  closeAll() { CAL.close(); CAL.closeBub(); },
  key(e) {
    if (App.route.name !== 'calendar' || e.ctrlKey || e.metaKey || e.altKey || $('.ovl')) return;
    const t = e.target; if (t && (t.closest('input, textarea, select, [contenteditable="true"]') || t.closest('.cal-cw, .cal-bub'))) return;
    const k = e.key.toLowerCase(), act = { arrowleft: () => CAL.step(-1), arrowright: () => CAL.step(1), t: () => { CAL.st.day = null; CAL._scrollTo = 'auto'; CAL.paint(); }, d: () => CAL.setView('day', CAL.days().includes(CAL.today()) ? CAL.today() : CAL.days()[0]), w: () => CAL.setView('week'),
      n: () => { const d = CAL.days().includes(CAL.today()) ? CAL.today() : CAL.days()[0]; CAL.create({ day: d, start: CAL.snap(Math.min(1380, CAL.nowMin() + 30)), x: innerWidth / 2 - 170, y: 140 }); } }[k];
    if (act) { e.preventDefault(); act(); }
  },
  /** For Settings' preview: a two-day planner in miniature. */
  preview() {
    const P = CAL.PAL, n = CAL.span(), slots = CAL.tn('slots', true) !== false, cards = [[0, 9, 10.5, 'Run 4 · seed', P.teal], [0, 11, 12, 'Lab meeting', P.blue], [1, 9.5, 10, 'Order media', P.slate], [1, 13, 15.5, 'Image beads', P.teal]];
    const hp = 150 / n;
    return [h('div.pv-cal', h('div.pv-cal-h', h('span'), h('b', 'Mon 16'), h('b.today', 'Tue 17')),
      h('div.pv-cal-b', h('div.pv-cal-t', [8, 10, 12, 14].map(x => h('span', { style: { top: (x - 8) * hp + 'px' } }, x + ':00'))),
        [0, 1].map(c => h('div.pv-cal-c', slots ? h('i.pv-slot', { style: { top: (c ? 10.25 - 8 : 10.75 - 8) * hp + 'px', height: (c ? 2.5 : 0.25) * hp + 'px' } }) : null,
          cards.filter(x => x[0] === c).map(([, s, e, t, col]) => h('div.pv-ec', { style: { top: (s - 8) * hp + 2 + 'px', height: Math.max(14, (e - s) * hp - 4) + 'px', background: col } }, t)),
          c === 1 ? h('i.pv-now', { style: { top: (10.6 - 8) * hp + 'px' } }) : null)))),
      PV.cap(n + ' hours fill the height; the rest scrolls. ' + (slots ? 'Free time between events shows dashed (7:00–21:00); a click adds an event there.' : 'Free time is not drawn; a click on an empty stretch still adds an event.') + ' Weeks start on ' + (CAL.wk0() ? 'Monday' : 'Sunday') + '.')];
  },
};
function isoWeekNo(d) { d = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())); const n = d.getUTCDay() || 7; d.setUTCDate(d.getUTCDate() + 4 - n); const y0 = new Date(Date.UTC(d.getUTCFullYear(), 0, 1)); return Math.ceil(((d - y0) / 864e5 + 1) / 7); }

const CalendarView = {
  canvas: true, title: true,
  render() { return CAL.render(); },
  update() { CAL.paint(); },
};
VIEWS.calendar = CalendarView;
{
  // the tab, right before Tasks
  if (!TABS.some(t => t[0] === 'calendar')) { const i = TABS.findIndex(t => t[0] === 'tasks'); TABS.splice(i >= 0 ? i : 1, 0, ['calendar', 'Calendar']); }
  document.addEventListener('keydown', e => { try { CAL.key(e); } catch (er) { console.warn('[calendar] key', er); } });
  document.addEventListener('mousedown', e => { if (CAL.cw && !CAL.cw.contains(e.target)) { CAL._swallow = !!e.target.closest('.cal-grid'); CAL.close(); setTimeout(() => { CAL._swallow = false; }, 400); }
    if (CAL.bubEl && !CAL.bubEl.contains(e.target)) CAL.closeBub(); }, true);
  // now moves: the line, once a minute
  setInterval(() => { if (App.route && App.route.name === 'calendar' && CAL.root && CAL.root.isConnected) { const n = $('.cal-now', CAL.root); if (n) n.style.top = `calc(var(--hpx) * ${CAL.nowMin() / 60})`; } }, 60000);
  // leaving the page closes what floats over it
  addEventListener('hashchange', () => { if (!location.hash.startsWith('#/calendar')) CAL.closeAll(); });
}
