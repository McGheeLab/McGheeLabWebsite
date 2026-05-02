/* availability.js — generate copy-paste availability text from Outlook events.
 *
 * Pulls events from /api/calendar/outlook-events, intersects them with a
 * configurable working window per day, expands them by a configurable buffer,
 * filters out free slots shorter than a minimum block, and emits a
 * natural-language string suitable for pasting into an email reply.
 *
 * Time zone: every date arithmetic here happens in the browser's local TZ —
 * the same TZ the recipient will assume when reading the message.
 */

const AVAIL_PREFS_KEY = 'cal.availability.prefs.v2';

const AVAIL_DEFAULTS = {
  start_date: '',                     // empty → today
  days_ahead: 14,
  dow: [false, true, true, true, true, true, false],  // Sun..Sat
  work_start: '09:00',
  work_end: '17:00',
  min_block_hours: 1.0,
  buffer_before_min: 15,
  buffer_after_min: 15,
  treat_all_day_as_busy: true,
  exclude_keywords: '',               // comma-separated, case-insensitive
  show_date: true,
  day_format: 'short',                // 'short' | 'long'
  list_join: 'or',                    // 'or' | 'comma' | 'slash'
  use_smart_all_day: true,
  smart_threshold_pct: 75,
  show_tz: true,
};

const AVAIL_STATE = {
  events: null,
  events_fetched_for_days: 0,
  loading: false,
  error: null,
};

function availLoadPrefs() {
  try {
    const raw = localStorage.getItem(AVAIL_PREFS_KEY);
    if (!raw) return { ...AVAIL_DEFAULTS };
    const p = JSON.parse(raw);
    return { ...AVAIL_DEFAULTS, ...p, dow: Array.isArray(p.dow) && p.dow.length === 7 ? p.dow : AVAIL_DEFAULTS.dow.slice() };
  } catch { return { ...AVAIL_DEFAULTS }; }
}

function availSavePrefs(p) {
  try { localStorage.setItem(AVAIL_PREFS_KEY, JSON.stringify(p)); } catch {}
}

// ---- Time helpers ----

function availParseHHMM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const h = parseInt(m[1], 10), mi = parseInt(m[2], 10);
  if (!Number.isFinite(h) || !Number.isFinite(mi)) return null;
  return Math.max(0, Math.min(24 * 60, h * 60 + mi));
}

function availTodayISO() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${da}`;
}

function availDateAddDays(iso, n) {
  // Treat YYYY-MM-DD as local-midnight to avoid TZ drift across DST.
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, (m || 1) - 1, d || 1);
  dt.setDate(dt.getDate() + n);
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

function availDateDow(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1).getDay();
}

function availDayName(iso, fmt) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, (m || 1) - 1, d || 1);
  return dt.toLocaleDateString('en-US', { weekday: fmt === 'long' ? 'long' : 'short' });
}

function availMonthDay(iso, fmt) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, (m || 1) - 1, d || 1);
  return dt.toLocaleDateString('en-US', { month: fmt === 'long' ? 'long' : 'short', day: 'numeric' });
}

function availTzShort() {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' }).formatToParts(new Date());
    const tz = parts.find(p => p.type === 'timeZoneName');
    return tz ? tz.value : '';
  } catch { return ''; }
}

// Parse an event start/end ISO that may be a date-only string ("2026-04-28")
// for all-day events or a local-time string ("2026-04-28T13:00:00") for timed
// events. The server emits timestamps without an offset suffix because the
// ICS feed already lives in the calendar owner's local zone.
function availParseEventTs(s, allDay) {
  if (!s) return null;
  if (allDay) {
    const [y, m, d] = s.slice(0, 10).split('-').map(Number);
    return new Date(y, (m || 1) - 1, d || 1);
  }
  // Local-naive ISO; new Date() interprets it as local — desired here.
  return new Date(s);
}

function availDayKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${da}`;
}

// ---- Free-block computation ----

function availMergeIntervals(arr) {
  if (!arr.length) return [];
  const sorted = arr.slice().sort((a, b) => a.s - b.s);
  const out = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i], last = out[out.length - 1];
    if (cur.s <= last.e) last.e = Math.max(last.e, cur.e);
    else out.push(cur);
  }
  return out;
}

function availSubtract(window, busy) {
  // free = window minus union(busy), each interval clipped to window
  const free = [];
  let cursor = window.s;
  for (const b of busy) {
    const bs = Math.max(b.s, window.s);
    const be = Math.min(b.e, window.e);
    if (be <= cursor) continue;
    if (bs > cursor) free.push({ s: cursor, e: bs });
    cursor = Math.max(cursor, be);
    if (cursor >= window.e) break;
  }
  if (cursor < window.e) free.push({ s: cursor, e: window.e });
  return free;
}

function computeAvailability(prefs, events) {
  const startISO = prefs.start_date || availTodayISO();
  const days = Math.max(1, Math.min(120, parseInt(prefs.days_ahead, 10) || 14));
  const wStart = availParseHHMM(prefs.work_start) ?? 9 * 60;
  const wEnd = availParseHHMM(prefs.work_end) ?? 17 * 60;
  if (wEnd <= wStart) return { days: [], error: 'Working hours: end must be after start.' };
  const window = { s: wStart, e: wEnd };
  const minBlockMin = Math.max(0, Math.round((parseFloat(prefs.min_block_hours) || 0) * 60));
  const bufBefore = Math.max(0, parseInt(prefs.buffer_before_min, 10) || 0);
  const bufAfter = Math.max(0, parseInt(prefs.buffer_after_min, 10) || 0);
  const excludeRaw = String(prefs.exclude_keywords || '').toLowerCase();
  const excludeKws = excludeRaw.split(',').map(s => s.trim()).filter(Boolean);

  // Bucket events by day for quick lookup. A timed event that crosses
  // midnight is added to every day it touches with its clipped slice.
  const eventsByDay = new Map();
  const pushBusy = (key, s, e) => {
    if (e <= s) return;
    if (!eventsByDay.has(key)) eventsByDay.set(key, []);
    eventsByDay.get(key).push({ s, e });
  };

  for (const ev of (events || [])) {
    const title = String(ev.title || '');
    if (excludeKws.length && excludeKws.some(kw => title.toLowerCase().includes(kw))) continue;

    if (ev.all_day) {
      if (!prefs.treat_all_day_as_busy) continue;
      // ICS DTEND for all-day is exclusive; if missing, treat as one day.
      const sDate = availParseEventTs(ev.start, true);
      const eDate = ev.end ? availParseEventTs(ev.end, true) : null;
      if (!sDate) continue;
      const cursor = new Date(sDate);
      const stop = eDate ? new Date(eDate) : new Date(sDate.getTime() + 24 * 3600 * 1000);
      while (cursor < stop) {
        pushBusy(availDayKey(cursor), 0, 24 * 60);
        cursor.setDate(cursor.getDate() + 1);
      }
      continue;
    }

    const sDt = availParseEventTs(ev.start, false);
    const eDt = ev.end ? availParseEventTs(ev.end, false) : (sDt ? new Date(sDt.getTime() + 30 * 60 * 1000) : null);
    if (!sDt || !eDt || eDt <= sDt) continue;

    // Apply buffers, then split by calendar day.
    const bufStart = new Date(sDt.getTime() - bufBefore * 60 * 1000);
    const bufEnd = new Date(eDt.getTime() + bufAfter * 60 * 1000);
    const cursor = new Date(bufStart.getFullYear(), bufStart.getMonth(), bufStart.getDate());
    while (cursor <= bufEnd) {
      const dayStart = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate());
      const dayEnd = new Date(dayStart.getTime() + 24 * 3600 * 1000);
      const segS = Math.max(bufStart.getTime(), dayStart.getTime());
      const segE = Math.min(bufEnd.getTime(), dayEnd.getTime());
      if (segE > segS) {
        const sm = Math.round((segS - dayStart.getTime()) / 60000);
        const em = Math.round((segE - dayStart.getTime()) / 60000);
        pushBusy(availDayKey(dayStart), sm, em);
      }
      cursor.setDate(cursor.getDate() + 1);
    }
  }

  const dayResults = [];
  for (let i = 0; i < days; i++) {
    const iso = availDateAddDays(startISO, i);
    const dow = availDateDow(iso);
    if (!prefs.dow[dow]) continue;
    const busyRaw = eventsByDay.get(iso) || [];
    const busy = availMergeIntervals(busyRaw);
    const free = availSubtract(window, busy)
      .filter(iv => (iv.e - iv.s) >= minBlockMin);
    dayResults.push({
      iso, dow,
      window: { ...window },
      busy,
      blocks: free,
      windowMinutes: window.e - window.s,
    });
  }

  return { days: dayResults, error: null };
}

// ---- Formatter ----

function availFmtTime(min) {
  if (min === 12 * 60) return { txt: 'noon', noPeriod: true, period: 'pm' };
  if (min === 0 || min === 24 * 60) return { txt: 'midnight', noPeriod: true, period: 'am' };
  const h24 = Math.floor(min / 60);
  const m = min % 60;
  let h = h24 % 12; if (h === 0) h = 12;
  const period = h24 < 12 ? 'am' : 'pm';
  const txt = m === 0 ? `${h}` : `${h}:${String(m).padStart(2, '0')}`;
  return { txt, period, noPeriod: false };
}

function availFmtRange(s, e) {
  const a = availFmtTime(s), b = availFmtTime(e);
  const aStr = a.noPeriod ? a.txt : `${a.txt}${a.period}`;
  const bStr = b.noPeriod ? b.txt : `${b.txt}${b.period}`;
  // Suppress the first period when both ends share am/pm ("1–3pm" not "1pm–3pm").
  if (!a.noPeriod && !b.noPeriod && a.period === b.period) {
    return `${a.txt}–${b.txt}${b.period}`;
  }
  return `${aStr}–${bStr}`;
}

function availJoiner(mode) {
  if (mode === 'comma') return ', ';
  if (mode === 'slash') return ' / ';
  return ' or ';
}

function availLabel(iso, prefs) {
  const dn = availDayName(iso, prefs.day_format);
  if (!prefs.show_date) return dn;
  const md = availMonthDay(iso, prefs.day_format);
  return prefs.day_format === 'long' ? `${dn}, ${md}` : `${dn} ${md}`;
}

function formatAvailability(prefs, dayResults) {
  if (!dayResults.length) return '(no days in range — check your day-of-week filter)';
  const joiner = availJoiner(prefs.list_join);
  const lines = [];
  for (const d of dayResults) {
    if (!d.blocks.length) continue;
    const totalFree = d.blocks.reduce((a, b) => a + (b.e - b.s), 0);
    const fullWindow = d.blocks.length === 1
      && d.blocks[0].s === d.window.s
      && d.blocks[0].e === d.window.e;
    const label = availLabel(d.iso, prefs);
    let body;
    if (fullWindow) {
      body = 'all day';
    } else if (prefs.use_smart_all_day
               && totalFree / d.windowMinutes >= (prefs.smart_threshold_pct / 100)
               && d.busy.length) {
      // Surface the busy gaps inside the window — same merge that produced
      // `d.blocks`, but inverted and clipped.
      const gaps = [];
      const merged = availMergeIntervals(d.busy);
      for (const b of merged) {
        const s = Math.max(b.s, d.window.s);
        const e = Math.min(b.e, d.window.e);
        if (e > s) gaps.push({ s, e });
      }
      const exceptStr = gaps.map(g => availFmtRange(g.s, g.e)).join(', ');
      body = exceptStr ? `all day except ${exceptStr}` : 'all day';
    } else {
      body = d.blocks.map(b => availFmtRange(b.s, b.e)).join(joiner);
    }
    lines.push(`${label}: ${body}`);
  }
  if (!lines.length) return '(no free blocks of that size in this range)';
  if (prefs.show_tz) {
    const tz = availTzShort();
    if (tz) lines.push('', `All times ${tz}.`);
  }
  return lines.join('\n');
}

// ---- Event fetch ----

async function availFetchEvents(daysAheadHint) {
  // Server returns events in the next N days. Pad so the user can browse
  // ahead without a refetch.
  const days = Math.max(60, Math.min(180, (daysAheadHint || 14) + 30));
  if (AVAIL_STATE.events && AVAIL_STATE.events_fetched_for_days >= days) {
    return AVAIL_STATE.events;
  }
  AVAIL_STATE.loading = true;
  AVAIL_STATE.error = null;
  try {
    const res = await fetch(`/api/calendar/outlook-events?days=${days}`);
    if (!res.ok) throw new Error(`server ${res.status}`);
    const result = await res.json();
    if (result.error) throw new Error(result.error);
    AVAIL_STATE.events = result.events || [];
    AVAIL_STATE.events_fetched_for_days = days;
    return AVAIL_STATE.events;
  } catch (err) {
    AVAIL_STATE.error = err.message || String(err);
    AVAIL_STATE.events = [];
    return [];
  } finally {
    AVAIL_STATE.loading = false;
  }
}

// ---- Rendering ----

function availInjectStyles() {
  if (document.getElementById('availability-styles')) return;
  const st = document.createElement('style');
  st.id = 'availability-styles';
  st.textContent = `
    .av-wrap{display:grid;grid-template-columns:340px 1fr;gap:18px;align-items:start}
    @media (max-width:900px){.av-wrap{grid-template-columns:1fr}}
    .av-controls{padding:14px 16px;background:#fff;border:1px solid #e5e7eb;border-radius:10px;display:flex;flex-direction:column;gap:12px}
    .av-controls h3{margin:0;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.6px}
    .av-row{display:flex;flex-direction:column;gap:4px}
    .av-row label{font-size:12px;color:#374151;font-weight:500}
    .av-row .av-hint{font-size:11px;color:#9ca3af}
    .av-row input[type=number],.av-row input[type=date],.av-row input[type=time],.av-row input[type=text],.av-row select{
      padding:5px 8px;font-size:13px;border:1px solid #d1d5db;border-radius:6px;background:#fff;width:100%
    }
    .av-row.inline{flex-direction:row;align-items:center;gap:8px}
    .av-row.inline input[type=number]{width:90px}
    .av-row.inline input[type=time]{width:115px}
    .av-pair{display:grid;grid-template-columns:1fr 1fr;gap:8px}
    .av-dow{display:flex;gap:4px;flex-wrap:wrap}
    .av-dow button{padding:4px 9px;font-size:12px;font-weight:600;border:1px solid #d1d5db;background:#f9fafb;color:#6b7280;border-radius:14px;cursor:pointer}
    .av-dow button.on{background:#2563eb;color:#fff;border-color:#2563eb}
    .av-output{display:flex;flex-direction:column;gap:10px}
    .av-output-toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
    .av-output-toolbar .av-status{font-size:12px;color:#6b7280;margin-left:auto}
    .av-output textarea{width:100%;min-height:380px;padding:14px 16px;font-size:14px;line-height:1.55;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,monospace;border:1px solid #d1d5db;border-radius:10px;background:#fff;resize:vertical}
    .av-error{padding:8px 12px;background:#fef2f2;border:1px solid #fecaca;color:#991b1b;border-radius:8px;font-size:12px}
    .av-info{padding:8px 12px;background:#eff6ff;border:1px solid #dbeafe;color:#1e40af;border-radius:8px;font-size:12px}
    .av-checkbox{display:flex;align-items:center;gap:6px;font-size:12px;color:#374151}
    .av-copy-ok{color:#15803d !important}
  `;
  document.head.appendChild(st);
}

function availDowLabel(i) {
  return ['S', 'M', 'T', 'W', 'T', 'F', 'S'][i];
}

async function renderAvailability() {
  availInjectStyles();
  const content = document.getElementById('content');
  const prefs = availLoadPrefs();
  if (!prefs.start_date) prefs.start_date = availTodayISO();

  const tz = availTzShort();
  content.innerHTML = `
    <div class="av-wrap">
      <div class="av-controls">
        <h3>Range</h3>
        <div class="av-pair">
          <div class="av-row"><label>Start date</label><input type="date" id="av-start"></div>
          <div class="av-row"><label>Days ahead</label><input type="number" id="av-days" min="1" max="120" step="1"></div>
        </div>
        <div class="av-row">
          <label>Days of week</label>
          <div class="av-dow" id="av-dow"></div>
        </div>

        <h3>Working hours</h3>
        <div class="av-pair">
          <div class="av-row"><label>Start</label><input type="time" id="av-work-start"></div>
          <div class="av-row"><label>End</label><input type="time" id="av-work-end"></div>
        </div>

        <h3>Constraints</h3>
        <div class="av-pair">
          <div class="av-row"><label>Min block (hours)</label><input type="number" id="av-min-block" min="0" step="0.25"></div>
          <div class="av-row"><label>Buffer before (min)</label><input type="number" id="av-buf-before" min="0" step="5"></div>
        </div>
        <div class="av-pair">
          <div class="av-row"><label>Buffer after (min)</label><input type="number" id="av-buf-after" min="0" step="5"></div>
          <div class="av-row"><label>All-day events</label>
            <select id="av-allday">
              <option value="busy">Treat as busy</option>
              <option value="ignore">Ignore</option>
            </select>
          </div>
        </div>
        <div class="av-row">
          <label>Exclude events containing</label>
          <input type="text" id="av-exclude" placeholder="e.g. tentative, hold, optional">
          <div class="av-hint">comma-separated, case-insensitive — events whose title matches are not treated as busy</div>
        </div>

        <h3>Output style</h3>
        <div class="av-pair">
          <div class="av-row"><label>Day name</label>
            <select id="av-dayfmt">
              <option value="short">Mon</option>
              <option value="long">Monday</option>
            </select>
          </div>
          <div class="av-row"><label>Join blocks with</label>
            <select id="av-join">
              <option value="or">or</option>
              <option value="comma">,</option>
              <option value="slash">/</option>
            </select>
          </div>
        </div>
        <label class="av-checkbox"><input type="checkbox" id="av-show-date"> Include date next to day name</label>
        <label class="av-checkbox"><input type="checkbox" id="av-show-tz"> Append timezone footer</label>
        <label class="av-checkbox"><input type="checkbox" id="av-smart"> Use "all day except &lt;gap&gt;" when mostly free</label>
        <div class="av-row inline" id="av-smart-thresh-row">
          <label style="margin:0">Threshold</label>
          <input type="number" id="av-smart-thresh" min="50" max="100" step="5">
          <span class="av-hint">% of window free</span>
        </div>
      </div>

      <div class="av-output">
        <div class="av-output-toolbar">
          <button class="btn primary" id="av-copy">Copy</button>
          <button class="btn" id="av-refresh">Refresh events</button>
          <button class="btn" id="av-reset" title="Restore default settings">Reset</button>
          <span class="av-status" id="av-status">${tz ? `local time · ${tz}` : 'local time'}</span>
        </div>
        <div id="av-error-host"></div>
        <textarea id="av-output" readonly placeholder="Loading events…"></textarea>
      </div>
    </div>
  `;

  // Populate controls from prefs.
  const $ = (id) => document.getElementById(id);
  $('av-start').value = prefs.start_date;
  $('av-days').value = prefs.days_ahead;
  $('av-work-start').value = prefs.work_start;
  $('av-work-end').value = prefs.work_end;
  $('av-min-block').value = prefs.min_block_hours;
  $('av-buf-before').value = prefs.buffer_before_min;
  $('av-buf-after').value = prefs.buffer_after_min;
  $('av-allday').value = prefs.treat_all_day_as_busy ? 'busy' : 'ignore';
  $('av-exclude').value = prefs.exclude_keywords;
  $('av-dayfmt').value = prefs.day_format;
  $('av-join').value = prefs.list_join;
  $('av-show-date').checked = !!prefs.show_date;
  $('av-show-tz').checked = !!prefs.show_tz;
  $('av-smart').checked = !!prefs.use_smart_all_day;
  $('av-smart-thresh').value = prefs.smart_threshold_pct;

  // DOW pill row.
  const dowHost = $('av-dow');
  const renderDow = () => {
    dowHost.innerHTML = '';
    for (let i = 0; i < 7; i++) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = availDowLabel(i);
      b.title = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][i];
      if (prefs.dow[i]) b.classList.add('on');
      b.addEventListener('click', () => {
        prefs.dow[i] = !prefs.dow[i];
        b.classList.toggle('on', prefs.dow[i]);
        scheduleRecompute();
      });
      dowHost.appendChild(b);
    }
  };
  renderDow();

  // Wire change handlers.
  const recompute = () => {
    // Pull live values into prefs.
    prefs.start_date = $('av-start').value || availTodayISO();
    prefs.days_ahead = Math.max(1, Math.min(120, parseInt($('av-days').value, 10) || 14));
    prefs.work_start = $('av-work-start').value || '09:00';
    prefs.work_end = $('av-work-end').value || '17:00';
    prefs.min_block_hours = Math.max(0, parseFloat($('av-min-block').value) || 0);
    prefs.buffer_before_min = Math.max(0, parseInt($('av-buf-before').value, 10) || 0);
    prefs.buffer_after_min = Math.max(0, parseInt($('av-buf-after').value, 10) || 0);
    prefs.treat_all_day_as_busy = $('av-allday').value === 'busy';
    prefs.exclude_keywords = $('av-exclude').value;
    prefs.day_format = $('av-dayfmt').value;
    prefs.list_join = $('av-join').value;
    prefs.show_date = $('av-show-date').checked;
    prefs.show_tz = $('av-show-tz').checked;
    prefs.use_smart_all_day = $('av-smart').checked;
    prefs.smart_threshold_pct = Math.max(50, Math.min(100, parseInt($('av-smart-thresh').value, 10) || 75));
    availSavePrefs(prefs);

    const errHost = $('av-error-host');
    errHost.innerHTML = '';
    if (AVAIL_STATE.error) {
      errHost.innerHTML = `<div class="av-error">Couldn't load Outlook events: ${escapeCalHtml(AVAIL_STATE.error)}. Showing working hours only.</div>`;
    }
    const result = computeAvailability(prefs, AVAIL_STATE.events || []);
    if (result.error) {
      errHost.innerHTML += `<div class="av-error">${escapeCalHtml(result.error)}</div>`;
      $('av-output').value = '';
      return;
    }
    $('av-output').value = formatAvailability(prefs, result.days);
  };
  const scheduleRecompute = calDebounce(recompute, 100);

  // Inputs that always trigger recompute on input or change.
  ['av-start','av-days','av-work-start','av-work-end','av-min-block',
   'av-buf-before','av-buf-after','av-allday','av-exclude','av-dayfmt',
   'av-join','av-show-date','av-show-tz','av-smart','av-smart-thresh']
    .forEach(id => {
      const el = $(id);
      const evt = (el.type === 'checkbox' || el.tagName === 'SELECT') ? 'change' : 'input';
      el.addEventListener(evt, scheduleRecompute);
    });

  $('av-copy').addEventListener('click', async () => {
    const txt = $('av-output').value;
    if (!txt) return;
    const btn = $('av-copy');
    try {
      await navigator.clipboard.writeText(txt);
      const old = btn.textContent;
      btn.textContent = 'Copied!';
      btn.classList.add('av-copy-ok');
      setTimeout(() => { btn.textContent = old; btn.classList.remove('av-copy-ok'); }, 1200);
    } catch {
      // Fallback: select the textarea so the user can hit ⌘C.
      $('av-output').select();
    }
  });

  $('av-refresh').addEventListener('click', async () => {
    AVAIL_STATE.events = null;
    AVAIL_STATE.events_fetched_for_days = 0;
    $('av-output').value = 'Refreshing events…';
    await availFetchEvents(prefs.days_ahead);
    recompute();
  });

  $('av-reset').addEventListener('click', () => {
    if (!confirm('Reset availability settings to defaults?')) return;
    try { localStorage.removeItem(AVAIL_PREFS_KEY); } catch {}
    renderAvailability();
  });

  // First load.
  $('av-output').value = 'Loading events…';
  await availFetchEvents(prefs.days_ahead);
  recompute();
}

// Expose for unit-style poking from devtools.
window.computeAvailability = computeAvailability;
window.formatAvailability = formatAvailability;
