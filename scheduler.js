/* ================================================================
   scheduler.js  —  Reusable Scheduling Engine
   Sessions mode: calendar multi-select days → drag time window on
                  scrollable time grid → session blocks with colors
   Freeform mode: when2meet-style drag-select availability
   Three views: Admin, Guest, Public
   Zero module state — all state passed via config object.
   ================================================================ */

window.McgheeLab = window.McgheeLab || {};

(() => {

/* ================================================================
   HELPERS
   ================================================================ */
function esc(s) { const el = document.createElement('div'); el.textContent = s ?? ''; return el.innerHTML; }

const DAY_NAMES = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];

const SESSION_COLORS = [
  { bg: 'rgba(91,174,209,.25)',  border: 'rgba(91,174,209,.6)',  cal: 'rgba(91,174,209,.55)', text: '#7cc8e8' },
  { bg: 'rgba(209,153,91,.25)',  border: 'rgba(209,153,91,.6)',  cal: 'rgba(209,153,91,.55)', text: '#e8c57c' },
  { bg: 'rgba(91,209,153,.25)',  border: 'rgba(91,209,153,.6)',  cal: 'rgba(91,209,153,.55)', text: '#7ce8b4' },
  { bg: 'rgba(175,91,209,.25)',  border: 'rgba(175,91,209,.6)',  cal: 'rgba(175,91,209,.55)', text: '#c87ce8' },
  { bg: 'rgba(209,91,120,.25)',  border: 'rgba(209,91,120,.6)',  cal: 'rgba(209,91,120,.55)', text: '#e87c96' },
];

/* ─── Normalize view names (backward compat) ─────────────── */
function normalizeView(v) {
  if (v === 'speaker') return 'guest';
  if (v === 'student') return 'public';
  return v || 'public';
}

/* ─── Date / Time ─────────────────────────────────────────── */
function fmtTime(t) {
  const [h, m] = String(t).split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h > 12 ? h - 12 : (h === 0 ? 12 : h);
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
}

function dateLabel(iso) {
  const d = new Date(iso + 'T12:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric' });
}

function selectedDaysToDays(selectedDays) {
  return (selectedDays || []).map(iso => {
    const d = new Date(iso + 'T12:00:00');
    const dow = DAY_NAMES[d.getDay()].toLowerCase();
    return { key: dow + '-' + iso.slice(8, 10), date: iso, label: dateLabel(iso) };
  }).sort((a, b) => a.date.localeCompare(b.date));
}

function datesToDays(startDate, endDate) {
  const days = [];
  const d = new Date(startDate + 'T12:00:00');
  const end = new Date(endDate + 'T12:00:00');
  while (d <= end) {
    const iso = d.toISOString().slice(0, 10);
    const dow = DAY_NAMES[d.getDay()].toLowerCase();
    days.push({ key: dow + '-' + iso.slice(8, 10), date: iso, label: dateLabel(iso) });
    d.setDate(d.getDate() + 1);
  }
  return days;
}

function slotDefsToSlots(slotDefs) {
  return (slotDefs || []).map((sd, i) => ({
    key: String(i + 1),
    label: `${fmtTime(sd.start)} – ${fmtTime(sd.end)}`,
    start: sd.start,
    end: sd.end
  }));
}

function timeToMinutes(t) {
  const [h, m] = String(t).split(':').map(Number);
  return h * 60 + (m || 0);
}

function minutesToTime(m) {
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/* ─── Expand schedule (derive days + slots from stored data) ─ */
function expandSchedule(sched) {
  // Derive days: sessionBlocks → selectedDays → date range
  let days;
  if (sched.sessionBlocks?.length) {
    const daySet = new Set();
    sched.sessionBlocks.forEach(sb => {
      // Support both new (sb.day) and old (sb.days) format
      if (sb.day) daySet.add(sb.day);
      else if (sb.days) sb.days.forEach(d => daySet.add(d));
    });
    days = selectedDaysToDays([...daySet]);
  } else if (sched.selectedDays?.length) {
    days = selectedDaysToDays(sched.selectedDays);
  } else if (sched.startDate && sched.endDate) {
    days = datesToDays(sched.startDate, sched.endDate);
  } else {
    days = [];
  }

  if (sched.mode === 'freeform') {
    const blocks = [];
    const gran = sched.granularity || 30;
    for (let m = (sched.startHour || 8) * 60; m < (sched.endHour || 18) * 60; m += gran) {
      const h = Math.floor(m / 60), min = m % 60;
      const time = String(h).padStart(2, '0') + String(min).padStart(2, '0');
      blocks.push({ time, label: fmtTime(`${h}:${min}`) });
    }
    return { days, blocks };
  }

  // Sessions mode: derive slotDefs from sessionBlocks if present
  let slotDefs;
  if (sched.sessionBlocks?.length) {
    // Unique time windows across all session blocks
    const seen = new Set();
    slotDefs = [];
    sched.sessionBlocks.forEach(sb => {
      const key = `${sb.start}-${sb.end}`;
      if (!seen.has(key)) { seen.add(key); slotDefs.push({ start: sb.start, end: sb.end }); }
    });
    slotDefs.sort((a, b) => timeToMinutes(a.start) - timeToMinutes(b.start));
  } else {
    slotDefs = sched.slotDefs || [];
  }

  const slots = slotDefsToSlots(slotDefs);
  const allSlots = [];

  if (sched.sessionBlocks?.length) {
    // Only create slots for day+time combos that actually exist in sessionBlocks
    sched.sessionBlocks.forEach(sb => {
      const slotIdx = slotDefs.findIndex(sd => sd.start === sb.start && sd.end === sb.end);
      if (slotIdx < 0) return;
      const slot = slots[slotIdx];
      // Support both new (sb.day) and old (sb.days) format
      const sbDays = sb.day ? [sb.day] : (sb.days || []);
      sbDays.forEach(dayIso => {
        const day = days.find(d => d.date === dayIso);
        if (day) allSlots.push({ id: `${day.key}-${slot.key}`, day, slot });
      });
    });
    allSlots.sort((a, b) => a.day.date.localeCompare(b.day.date) || timeToMinutes(slotDefs.find(sd => sd.start === a.slot.start)?.start || '0') - timeToMinutes(slotDefs.find(sd => sd.start === b.slot.start)?.start || '0'));
  } else {
    days.forEach(d => slots.forEach(s => allSlots.push({ id: `${d.key}-${s.key}`, day: d, slot: s })));
  }

  return { days, slots, allSlots };
}

function slotLabel(slotId, allSlots) {
  const info = (allSlots || []).find(s => s.id === slotId);
  return info ? `${info.day.label} ${info.slot.label}` : slotId;
}

function heatColor(count, max) {
  if (!count) return 'rgba(255,255,255,0.03)';
  const t = count / Math.max(max, 1);
  return `hsl(${220 - t * 160},${55 + t * 25}%,${18 + t * 22}%)`;
}

function defaultGuestInstructions(guestFields, mode) {
  let text = mode === 'freeform'
    ? 'Click and drag on the schedule below to mark the times you are available.'
    : 'Check all time slots you are available for on the schedule below.';
  const gf = guestFields || [];
  if (gf.includes('talkSummary')) text += '\n\nPlease provide a brief summary of your talk or presentation topic.';
  if (gf.includes('questions')) text += '\n\nSubmit three discussion questions for the audience.';
  if (gf.includes('presentationLink')) text += '\n\nShare a link to your presentation materials when ready.';
  if (!gf.length) text += '\n\nOnce you have saved your availability, you are all set.';
  return text;
}

function daysLabel(days) {
  if (!days.length) return '';
  if (days.length === 1) return days[0].label;
  return `${days[0].label} – ${days[days.length - 1].label}`;
}

/* ─── Optimization (sessions mode) ────────────────────────── */
function optimizeSchedule(speakers) {
  const eligible = speakers.filter(s => s.availability?.length > 0);
  eligible.sort((a, b) => a.availability.length - b.availability.length);
  const assigned = {}, result = [];
  for (const sp of eligible) {
    const open = sp.availability.filter(sid => !assigned[sid]);
    if (!open.length) { result.push({ speaker: sp, slot: null, reason: 'No open slots' }); continue; }
    open.sort((a, b) => {
      const cA = eligible.filter(s => s.id !== sp.id && !result.find(r => r.speaker.id === s.id && r.slot) && s.availability.includes(a)).length;
      const cB = eligible.filter(s => s.id !== sp.id && !result.find(r => r.speaker.id === s.id && r.slot) && s.availability.includes(b)).length;
      return cA - cB;
    });
    assigned[open[0]] = sp;
    result.push({ speaker: sp, slot: open[0], reason: `${sp.availability.length} slot(s) available` });
  }
  return result;
}

/* ================================================================
   CALENDAR — multi-select month view with session-colored days
   ================================================================ */
function calendarHTML(year, month, selectedDays, sessionBlocks) {
  const sel = new Set(selectedDays || []);
  const first = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0).getDate();
  const startDow = first.getDay();

  // Build map: date → list of session block color indices
  const dayColors = {};
  if (sessionBlocks) {
    sessionBlocks.forEach(sb => {
      const ci = sb.color ?? 0;
      // Support both new (sb.day) and old (sb.days) format
      const sbDays = sb.day ? [sb.day] : (sb.days || []);
      sbDays.forEach(d => {
        if (!dayColors[d]) dayColors[d] = [];
        if (!dayColors[d].includes(ci)) dayColors[d].push(ci);
      });
    });
  }

  let html = `<div class="sched-calendar" data-year="${year}" data-month="${month}">
    <div class="sched-cal-header">
      <button type="button" class="btn btn-small sched-cal-prev">&larr;</button>
      <span>${MONTH_NAMES[month]} ${year}</span>
      <button type="button" class="btn btn-small sched-cal-next">&rarr;</button>
    </div>
    <div class="sched-cal-grid">
      <div class="sched-cal-dow">Su</div><div class="sched-cal-dow">Mo</div><div class="sched-cal-dow">Tu</div>
      <div class="sched-cal-dow">We</div><div class="sched-cal-dow">Th</div><div class="sched-cal-dow">Fr</div><div class="sched-cal-dow">Sa</div>`;

  for (let i = 0; i < startDow; i++) html += '<div class="sched-cal-cell sched-cal-empty"></div>';

  for (let d = 1; d <= lastDay; d++) {
    const iso = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const isSelected = sel.has(iso);
    const colors = dayColors[iso];
    let style = '';
    let extraClass = '';
    if (isSelected) {
      extraClass = ' sched-cal-selected';
    } else if (colors && colors.length > 0) {
      // Show the first session block's color as background
      const c = SESSION_COLORS[colors[0] % SESSION_COLORS.length];
      style = ` style="background:${c.cal};color:#031a16;font-weight:700;"`;
      extraClass = ' sched-cal-saved';
      // Multiple sessions: show dots
    }
    let dots = '';
    if (colors && colors.length > 0 && !isSelected) {
      dots = '<div class="sched-cal-dots">' + colors.map(ci => `<span class="sched-cal-dot" style="background:${SESSION_COLORS[ci % SESSION_COLORS.length].border};"></span>`).join('') + '</div>';
    }
    html += `<div class="sched-cal-cell sched-cal-day${extraClass}" data-date="${iso}"${style}>${d}${dots}</div>`;
  }

  html += '</div></div>';
  return html;
}

function wireCalendar(containerId, selectedDays, onChange, sessionBlocks) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const sel = new Set(selectedDays || []);
  let year, month;

  function init() {
    const cal = container.querySelector('.sched-calendar');
    year = parseInt(cal?.dataset.year) || new Date().getFullYear();
    month = parseInt(cal?.dataset.month) || new Date().getMonth();
  }

  function redraw() {
    container.innerHTML = calendarHTML(year, month, [...sel], sessionBlocks);
    attachListeners();
  }

  function attachListeners() {
    container.querySelector('.sched-cal-prev')?.addEventListener('click', () => {
      month--; if (month < 0) { month = 11; year--; } redraw();
    });
    container.querySelector('.sched-cal-next')?.addEventListener('click', () => {
      month++; if (month > 11) { month = 0; year++; } redraw();
    });
    container.querySelectorAll('.sched-cal-day').forEach(cell => {
      cell.addEventListener('click', () => {
        const date = cell.dataset.date;
        if (sel.has(date)) sel.delete(date); else sel.add(date);
        redraw();
        if (onChange) onChange([...sel].sort());
      });
    });
  }

  init();
  attachListeners();
  return { redraw, updateBlocks(blocks) { sessionBlocks = blocks; redraw(); } };
}

/* ================================================================
   UNIFIED BUILDER — calendar (left) + day-column time grid (right)
   Session mode: click to place blocks of predetermined duration
   Freeform mode: click/drag cells to toggle availability
   ================================================================ */

function builderHTML(mode, sessionBlocks, selectedDays) {
  const durOpts = [15,30,45,60,90,120].map(d => {
    const label = d < 60 ? `${d} min` : (d % 60 === 0 ? `${d/60} hr` : `${Math.floor(d/60)}h ${d%60}m`);
    return `<option value="${d}">${label}</option>`;
  }).join('');

  return `
    <div class="sb-unified">
      <div class="sb-left">
        <div id="sb-calendar"></div>
      </div>
      <div class="sb-right">
        ${mode === 'sessions' ? `
          <div class="sb-toolbar">
            <label class="muted-text" style="font-size:.8rem;">Session length:</label>
            <select id="sb-duration">${durOpts}</select>
          </div>` : ''}
        <div id="sb-daygrid-wrap">
          <div id="sb-daygrid" class="sb-daygrid"></div>
        </div>
        <p id="sb-hint" class="muted-text" style="font-size:.8rem;margin-top:6px;">Select days on the calendar to build the time grid.</p>
      </div>
    </div>
    ${mode === 'sessions' ? `
    <div class="form-group" style="margin-top:12px;">
      <label style="font-weight:600;">Sessions</label>
      <div id="sb-sessions-list"></div>
    </div>` : ''}`;
}

function sessionsListHTML(blocks) {
  if (!blocks.length) return '<p class="muted-text">No sessions yet. Click on the time grid to place blocks.</p>';
  let html = '<div class="sb-sessions">';
  blocks.forEach((sb, i) => {
    const c = SESSION_COLORS[sb.color % SESSION_COLORS.length];
    html += `<div class="sb-session-item" style="border-left:4px solid ${c.border};background:${c.bg};">
      <div class="sb-session-info">
        <strong style="color:${c.text};">${fmtTime(sb.start)} – ${fmtTime(sb.end)}</strong>
        <span class="muted-text" style="font-size:.8rem;">${dateLabel(sb.day)}</span>
      </div>
      <button type="button" class="btn btn-danger btn-small sb-remove-session" data-sb-idx="${i}">&times;</button>
    </div>`;
  });
  html += '</div>';
  return html;
}

/* ─── Day-column time grid ────────────────────────────────── */
function dayGridHTML(sortedDays, sessionBlocks, freeformCells) {
  if (!sortedDays.length) return '';
  const startMin = 7 * 60, endMin = 21 * 60, step = 15;
  const cols = sortedDays.length;

  let html = `<div class="sb-daygrid-inner" style="grid-template-columns:56px repeat(${cols},1fr);">`;
  // Header row
  html += '<div class="sb-dg-corner"></div>';
  sortedDays.forEach(d => { html += `<div class="sb-dg-dayhead">${dateLabel(d)}</div>`; });

  for (let m = startMin; m < endMin; m += step) {
    const t = minutesToTime(m);
    const showLabel = m % 60 === 0;
    html += `<div class="sb-dg-time${showLabel ? ' sb-dg-hour' : ''}">${showLabel ? fmtTime(t) : ''}</div>`;
    sortedDays.forEach(d => {
      // Check session blocks for this cell
      let blockColor = null, blockId = null;
      if (sessionBlocks) {
        for (const sb of sessionBlocks) {
          if (sb.day !== d) continue;
          const sbS = timeToMinutes(sb.start), sbE = timeToMinutes(sb.end);
          if (m >= sbS && m < sbE) { blockColor = SESSION_COLORS[sb.color % SESSION_COLORS.length]; blockId = sb.id; break; }
        }
      }
      // Check freeform selected cells
      const ffKey = `${d}-${t.replace(':', '')}`;
      const ffSel = freeformCells && freeformCells.has(ffKey);
      let cls = 'sb-dg-cell';
      let style = '';
      if (blockColor) {
        cls += ' sb-dg-block';
        style = `background:${blockColor.bg};border-color:${blockColor.border};`;
      } else if (ffSel) {
        cls += ' sb-dg-selected';
      }
      if (showLabel) cls += ' sb-dg-hour-cell';
      html += `<div class="${cls}" data-day="${d}" data-minutes="${m}" data-ffkey="${ffKey}" style="${style}"${blockId ? ` data-block-id="${blockId}"` : ''}></div>`;
    });
  }
  html += '</div>';
  return html;
}

/* ─── Wire the unified builder ────────────────────────────── */
function wireBuilder(containerId, mode, sessionBlocks, freeformCells, sessionDuration, onChange) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const blocks = sessionBlocks ? sessionBlocks.map(b => ({...b})) : [];
  const ffCells = new Set(freeformCells || []);
  let selectedDays = [];
  let calApi = null;
  let duration = sessionDuration || 60;

  function fire() {
    if (onChange) onChange({ sessionBlocks: [...blocks], freeformCells: [...ffCells], selectedDays: [...selectedDays] });
  }

  function sortedSelectedDays() { return [...selectedDays].sort(); }

  function rebuildGrid() {
    const gridEl = container.querySelector('#sb-daygrid');
    const hint = container.querySelector('#sb-hint');
    const sorted = sortedSelectedDays();
    if (!sorted.length) {
      if (gridEl) gridEl.innerHTML = '';
      if (hint) hint.style.display = '';
      return;
    }
    if (hint) hint.style.display = 'none';
    if (gridEl) {
      gridEl.innerHTML = dayGridHTML(sorted, blocks, ffCells);
      wireGridInteraction();
    }
  }

  function refreshSessionsList() {
    const listEl = container.querySelector('#sb-sessions-list');
    if (!listEl) return;
    listEl.innerHTML = sessionsListHTML(blocks);
    listEl.querySelectorAll('.sb-remove-session').forEach(btn => {
      btn.addEventListener('click', () => {
        blocks.splice(parseInt(btn.dataset.sbIdx), 1);
        blocks.forEach((b, i) => { b.color = i % SESSION_COLORS.length; });
        refreshSessionsList();
        rebuildGrid();
        if (calApi) calApi.updateBlocks(blocks);
        fire();
      });
    });
  }

  function wireGridInteraction() {
    const gridEl = container.querySelector('#sb-daygrid');
    if (!gridEl) return;

    if (mode === 'sessions') {
      // Click to place / remove a session block
      gridEl.querySelectorAll('.sb-dg-cell').forEach(cell => {
        cell.addEventListener('click', () => {
          const bid = cell.dataset.blockId;
          if (bid) {
            // Remove existing block
            const idx = blocks.findIndex(b => b.id === bid);
            if (idx >= 0) blocks.splice(idx, 1);
            blocks.forEach((b, i) => { b.color = i % SESSION_COLORS.length; });
          } else {
            // Place new block
            const day = cell.dataset.day;
            const startM = parseInt(cell.dataset.minutes);
            const endM = startM + duration;
            // Check overlap
            const overlaps = blocks.some(b => {
              if (b.day !== day) return false;
              const bS = timeToMinutes(b.start), bE = timeToMinutes(b.end);
              return startM < bE && endM > bS;
            });
            if (overlaps) return;
            blocks.push({
              id: 'sb-' + Date.now().toString(36),
              day,
              start: minutesToTime(startM),
              end: minutesToTime(Math.min(endM, 21 * 60)),
              color: blocks.length % SESSION_COLORS.length
            });
          }
          refreshSessionsList();
          rebuildGrid();
          if (calApi) calApi.updateBlocks(blocks);
          fire();
        });
      });
    } else {
      // Freeform: click+drag to paint/erase cells
      let dragging = false, paintMode = null;
      function applyPaint(cell) {
        const key = cell.dataset.ffkey;
        if (!key) return;
        if (paintMode === 'select') { ffCells.add(key); cell.classList.add('sb-dg-selected'); }
        else { ffCells.delete(key); cell.classList.remove('sb-dg-selected'); }
      }
      gridEl.addEventListener('pointerdown', e => {
        const cell = e.target.closest('.sb-dg-cell');
        if (!cell) return;
        e.preventDefault();
        gridEl.setPointerCapture(e.pointerId);
        dragging = true;
        paintMode = cell.classList.contains('sb-dg-selected') ? 'deselect' : 'select';
        applyPaint(cell);
      });
      gridEl.addEventListener('pointermove', e => {
        if (!dragging) return;
        const el = document.elementFromPoint(e.clientX, e.clientY);
        const cell = el?.closest('.sb-dg-cell');
        if (cell) applyPaint(cell);
      });
      gridEl.addEventListener('pointerup', () => { if (dragging) { dragging = false; fire(); } });
      gridEl.addEventListener('pointercancel', () => { dragging = false; });
    }
  }

  // Duration selector (sessions only)
  const durSel = container.querySelector('#sb-duration');
  if (durSel) {
    durSel.value = String(duration);
    durSel.addEventListener('change', () => { duration = parseInt(durSel.value) || 60; });
  }

  // Calendar
  const calMonth = (() => {
    if (blocks.length && blocks[0].day) return new Date(blocks[0].day + 'T12:00:00');
    if (selectedDays.length) return new Date(selectedDays[0] + 'T12:00:00');
    return new Date();
  })();
  const calEl = container.querySelector('#sb-calendar');
  if (calEl) {
    calEl.innerHTML = calendarHTML(calMonth.getFullYear(), calMonth.getMonth(), selectedDays, blocks);
    calApi = wireCalendar('sb-calendar', selectedDays, (days) => {
      selectedDays = days;
      rebuildGrid();
    }, blocks);
  }

  rebuildGrid();
  if (mode === 'sessions') refreshSessionsList();

  return {
    getBlocks() { return [...blocks]; },
    getCells() { return [...ffCells]; },
    getDays() { return sortedSelectedDays(); },
    getDuration() { return duration; }
  };
}

/* ================================================================
   GRID RENDERERS
   ================================================================ */
function sessionsGridHTML(expanded, speakers, isAdmin) {
  const { days, slots, allSlots } = expanded;
  if (!days.length || !slots.length) return '<p class="muted-text">No schedule configured yet.</p>';

  const assignments = {};
  speakers.forEach(sp => { if (sp.assignedSlot) assignments[sp.assignedSlot] = sp; });
  const availMap = {};
  allSlots.forEach(s => { availMap[s.id] = []; });
  speakers.forEach(sp => (sp.availability || []).forEach(sid => { if (availMap[sid]) availMap[sid].push(sp); }));
  const maxHeat = Math.max(...Object.values(availMap).map(a => a.length), 1);

  let html = `<div class="schedule-grid" style="grid-template-columns:140px repeat(${days.length},1fr);">`;
  html += '<div class="schedule-cell schedule-corner"></div>';
  days.forEach(d => { html += `<div class="schedule-cell schedule-day-header">${esc(d.label)}</div>`; });
  slots.forEach(s => {
    html += `<div class="schedule-cell schedule-time-header">${esc(s.label)}</div>`;
    days.forEach(d => {
      const sid = `${d.key}-${s.key}`;
      const sp = assignments[sid];
      const avails = availMap[sid] || [];
      const count = avails.length;
      const isValid = allSlots.some(as => as.id === sid);
      if (!isValid) {
        html += '<div class="schedule-cell schedule-slot schedule-slot-disabled"></div>';
      } else if (sp) {
        html += `<div class="schedule-cell schedule-slot schedule-slot-filled"><span class="schedule-speaker-name">${esc(sp.speakerName)}</span></div>`;
      } else if (isAdmin && count > 0) {
        const names = avails.map(a => esc(a.speakerName.split(' ')[0]));
        const shown = names.slice(0, 3).join(', ') + (count > 3 ? ` <span class="schedule-avail-more">+${count - 3}</span>` : '');
        const tip = avails.map(a => a.speakerName).join(', ');
        html += `<div class="schedule-cell schedule-slot schedule-slot-avail" style="background:${heatColor(count, maxHeat)};" data-slot="${sid}" title="${esc(tip)}"><span class="schedule-avail-names">${shown}</span></div>`;
      } else {
        html += `<div class="schedule-cell schedule-slot" data-slot="${sid}"><span class="schedule-empty">Open</span></div>`;
      }
    });
  });
  html += '</div>';
  if (isAdmin && speakers.length > 0) {
    html += '<div class="ff-legend" style="margin-top:8px;"><span class="muted-text" style="font-size:.75rem;">Availability: </span>';
    for (let i = 0; i <= Math.min(maxHeat, 5); i++) html += `<span class="ff-legend-swatch" style="background:${heatColor(i, Math.min(maxHeat, 5))};">${i || ''}</span>`;
    if (maxHeat > 5) html += '<span class="muted-text" style="font-size:.75rem;"> +</span>';
    html += '</div>';
  }
  return html;
}

function freeformGridHTML(expanded, speakers, isAdmin) {
  const { days, blocks } = expanded;
  if (!days.length || !blocks.length) return '<p class="muted-text">No schedule configured yet.</p>';

  const availMap = {};
  days.forEach(d => blocks.forEach(b => { availMap[`${d.date}-${b.time}`] = []; }));
  speakers.forEach(sp => (sp.availability || []).forEach(bid => { if (availMap[bid]) availMap[bid].push(sp); }));
  const maxHeat = Math.max(...Object.values(availMap).map(a => a.length), 1);

  let html = `<div class="freeform-grid" style="grid-template-columns:68px repeat(${days.length},1fr);">`;
  html += '<div class="ff-cell ff-corner"></div>';
  days.forEach(d => { html += `<div class="ff-cell ff-day-header">${esc(d.label)}</div>`; });
  blocks.forEach(b => {
    html += `<div class="ff-cell ff-time-label">${esc(b.label)}</div>`;
    days.forEach(d => {
      const bid = `${d.date}-${b.time}`;
      const avails = availMap[bid] || [];
      const count = avails.length;
      const bg = isAdmin ? heatColor(count, maxHeat) : (count > 0 ? heatColor(count, maxHeat) : 'rgba(255,255,255,0.03)');
      const cl = isAdmin && count > 0 ? `<span class="ff-count">${count}</span>` : '';
      const tip = isAdmin && count > 0 ? ` title="${esc(avails.map(a => a.speakerName).join(', '))}"` : '';
      html += `<div class="ff-cell ff-block" data-block="${bid}" style="background:${bg};"${tip}>${cl}</div>`;
    });
  });
  html += '</div>';
  if (isAdmin) {
    html += '<div class="ff-legend"><span class="muted-text" style="font-size:.75rem;">Availability: </span>';
    for (let i = 0; i <= 5; i++) html += `<span class="ff-legend-swatch" style="background:${heatColor(i, 5)};">${i || ''}</span>`;
    html += '<span class="muted-text" style="font-size:.75rem;"> +</span></div>';
  }
  return html;
}

function gridHTML(config) {
  const expanded = expandSchedule(config.schedule);
  const vt = normalizeView(config.viewType);
  const isAdmin = vt === 'admin' && normalizeView(config.adminViewMode) === 'admin';
  if (config.schedule.mode === 'freeform') return freeformGridHTML(expanded, config.speakers, isAdmin);
  return sessionsGridHTML(expanded, config.speakers, isAdmin);
}

/* ─── Freeform drag-to-select ───────────────────────────── */
function wireFreeformDrag(containerId, selected, onSave) {
  const container = document.getElementById(containerId);
  if (!container) return;
  let dragging = false, paintMode = null;
  const selectedSet = new Set(selected);

  function applyPaint(cell) {
    const bid = cell.dataset.block; if (!bid) return;
    if (paintMode === 'select') { selectedSet.add(bid); cell.classList.add('ff-selected'); }
    else { selectedSet.delete(bid); cell.classList.remove('ff-selected'); }
  }

  container.querySelectorAll('.ff-block[data-block]').forEach(cell => {
    if (selectedSet.has(cell.dataset.block)) cell.classList.add('ff-selected');
  });

  container.addEventListener('pointerdown', e => {
    const cell = e.target.closest('.ff-block[data-block]');
    if (!cell) return;
    e.preventDefault(); dragging = true;
    paintMode = cell.classList.contains('ff-selected') ? 'deselect' : 'select';
    applyPaint(cell);
  });
  container.addEventListener('pointermove', e => {
    if (!dragging) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const cell = el?.closest('.ff-block[data-block]');
    if (cell) applyPaint(cell);
  });
  const endDrag = () => { dragging = false; paintMode = null; };
  container.addEventListener('pointerup', endDrag);
  container.addEventListener('pointerleave', endDrag);

  if (onSave) {
    document.getElementById('save-availability-btn')?.addEventListener('click', async () => {
      const st = document.getElementById('avail-status');
      st.textContent = 'Saving...';
      try { await onSave([...selectedSet]); st.textContent = 'Saved!'; setTimeout(() => { st.textContent = ''; }, 2000); }
      catch (e) { st.textContent = 'Error.'; console.error(e); }
    });
  }
}

/* ================================================================
   CONFIRMED SPEAKERS
   ================================================================ */
function confirmedSpeakersHTML(speakers, expanded, mode, guestFields) {
  const assigned = speakers.filter(s => s.assignedSlot);
  if (!assigned.length) return '<p class="muted-text">Schedule not finalized yet.</p>';
  const gf = guestFields || [];
  const allSlots = expanded.allSlots || [];
  assigned.sort((a, b) => {
    const iA = allSlots.findIndex(s => s.id === a.assignedSlot);
    const iB = allSlots.findIndex(s => s.id === b.assignedSlot);
    return iA - iB;
  });
  let html = '';
  assigned.forEach(sp => {
    const qs = (sp.questions || []).filter(q => q);
    html += `<div class="confirmed-speaker-card card reveal">
      <div class="confirmed-speaker-header">
        <span class="badge" style="background:var(--accent,#5baed1);color:#031a16;padding:4px 10px;border-radius:6px;font-weight:600;font-size:.8rem;">${esc(slotLabel(sp.assignedSlot, allSlots))}</span>
        <strong>${esc(sp.speakerName)}</strong>
      </div>
      ${gf.includes('talkSummary') && sp.talkSummary ? `<p class="confirmed-speaker-summary">${esc(sp.talkSummary)}</p>` : ''}
      ${gf.includes('questions') && qs.length ? `<div class="confirmed-speaker-questions"><h5>Discussion Questions</h5><ol>${qs.map(q => `<li>${esc(q)}</li>`).join('')}</ol></div>` : ''}
      ${gf.includes('presentationLink') && sp.presentationLink ? `<p><a href="${esc(sp.presentationLink)}" target="_blank" rel="noopener" style="color:var(--accent,#5baed1);">Presentation Materials &rarr;</a></p>` : ''}
    </div>`;
  });
  return html;
}

/* ================================================================
   VIEW BUILDERS
   ================================================================ */

/* ─── View Switcher (admin only) ──────────────────────────── */
function viewSwitcherHTML(activeMode, speakers, previewSpeakerIdx) {
  activeMode = normalizeView(activeMode);
  const modes = [
    { key: 'admin', label: 'Admin' },
    { key: 'guest', label: 'Guest' },
    { key: 'public', label: 'Public' }
  ];
  const btns = modes.map(m =>
    `<button type="button" class="mode-btn ${m.key === activeMode ? 'mode-active' : ''}" data-view-mode="${m.key}">${m.label}</button>`
  ).join('');
  let picker = '';
  if (activeMode === 'guest' && speakers.length > 1) {
    const opts = speakers.map((sp, i) =>
      `<option value="${i}" ${i === previewSpeakerIdx ? 'selected' : ''}>${esc(sp.speakerName)}</option>`
    ).join('');
    picker = `<select id="preview-speaker-select" style="margin-left:8px;">${opts}</select>`;
  }
  return `<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:16px;">
    <span class="muted-text" style="font-size:.85rem;">View as:</span>
    <div class="mode-toggle">${btns}</div>${picker}</div>`;
}

/* ─── Public View ────────────────────────────────────────── */
function publicViewHTML(config) {
  const expanded = expandSchedule(config.schedule);
  const dl = daysLabel(expanded.days);
  const gridStr = config.schedule.mode === 'freeform'
    ? freeformGridHTML(expanded, config.speakers, false)
    : sessionsGridHTML(expanded, config.speakers, false);
  const confirmedStr = confirmedSpeakersHTML(config.speakers, expanded, config.schedule.mode, config.schedule.guestFields);
  return `
    <h3>Schedule${dl ? ' — ' + dl : ''}</h3>
    <div id="schedule-grid-container">${gridStr}</div>
    <h3 style="margin-top:24px;">Confirmed</h3>
    <div id="confirmed-speakers-list">${confirmedStr}</div>
  `;
}

/* ─── Guest View ──────────────────────────────────────────── */
function guestViewHTML(config) {
  const speaker = config.currentSpeaker;
  const schedule = config.schedule;
  const expanded = expandSchedule(schedule);
  const avail = speaker.availability || [];
  const questions = speaker.questions || ['', '', ''];
  const mode = schedule.mode || 'sessions';
  const allSlots = expanded.allSlots || [];
  const assignedLabel = speaker.assignedSlot ? slotLabel(speaker.assignedSlot, allSlots) : null;

  const gf = schedule.guestFields || [];
  const showSummary = gf.includes('talkSummary');
  const showQuestions = gf.includes('questions');
  const showLink = gf.includes('presentationLink');
  const hasAnyFields = showSummary || showQuestions || showLink;

  const hasAvail = avail.length > 0, hasSummary = !!speaker.talkSummary;
  const hasQs = (speaker.questions || []).some(q => q), hasLink = !!speaker.presentationLink;
  const pill = (ok, label) => `<span class="progress-pill ${ok ? 'progress-pill--done' : 'progress-pill--pending'}">${ok ? '&#10003;' : '&#9675;'} ${label}</span>`;
  const instructions = schedule.guestInstructions || defaultGuestInstructions(gf, mode);

  let availHTML = '';
  if (mode === 'sessions') {
    const { days, slots } = expanded;
    availHTML = `<div class="availability-grid" style="grid-template-columns:140px repeat(${days.length},1fr);">
      <div class="schedule-cell schedule-corner"></div>
      ${days.map(d => `<div class="schedule-cell schedule-day-header">${esc(d.label)}</div>`).join('')}
      ${slots.map(s => `<div class="schedule-cell schedule-time-header">${esc(s.label)}</div>
        ${days.map(d => { const sid = `${d.key}-${s.key}`;
          const isValid = allSlots.some(as => as.id === sid);
          if (!isValid) return '<div class="schedule-cell schedule-slot schedule-slot-disabled"></div>';
          const chk = avail.includes(sid) ? 'checked' : '';
          return `<div class="schedule-cell schedule-slot schedule-slot-vote"><label class="vote-label"><input type="checkbox" class="avail-checkbox" data-slot="${sid}" ${chk} /><span class="vote-check"></span></label></div>`;
        }).join('')}`).join('')}
    </div>`;
  } else {
    const { days, blocks } = expanded;
    const sel = new Set(avail);
    availHTML = `<div class="freeform-grid" id="speaker-avail-grid" style="grid-template-columns:68px repeat(${days.length},1fr);touch-action:none;">
      <div class="ff-cell ff-corner"></div>
      ${days.map(d => `<div class="ff-cell ff-day-header">${esc(d.label)}</div>`).join('')}
      ${blocks.map(b => `<div class="ff-cell ff-time-label">${esc(b.label)}</div>
        ${days.map(d => { const bid = `${d.date}-${b.time}`; return `<div class="ff-cell ff-block ${sel.has(bid) ? 'ff-selected' : ''}" data-block="${bid}"></div>`; }).join('')}`).join('')}
    </div>`;
  }

  return `
    <div class="card" style="padding:1.25rem;margin-bottom:16px;">
      <h3>Welcome, ${esc(speaker.speakerName)}</h3>
      ${assignedLabel
        ? `<div class="guest-assignment guest-assignment--assigned"><span class="badge" style="background:var(--accent,#5baed1);color:#031a16;padding:4px 10px;border-radius:6px;font-weight:600;font-size:.8rem;">${esc(assignedLabel)}</span> <span class="muted-text">&mdash; Your assigned slot</span></div>`
        : '<div class="guest-assignment guest-assignment--pending">Not yet assigned a slot.</div>'}
      <div class="guest-instructions"><p>${esc(instructions).replace(/\n/g, '<br>')}</p></div>
      <div class="speaker-progress">${pill(hasAvail, 'Availability')}${showSummary ? pill(hasSummary, 'Summary') : ''}${showQuestions ? pill(hasQs, 'Questions') : ''}${showLink ? pill(hasLink, 'Materials') : ''}</div>
    </div>

    <div class="card" style="padding:1.25rem;margin-bottom:16px;">
      <h4>Your Availability</h4>
      <p class="muted-text" style="margin:0 0 12px;font-size:.85rem;">${mode === 'freeform' ? 'Click and drag to mark available times.' : 'Check all slots you are available for.'}</p>
      ${availHTML}
      <div style="margin-top:12px;"><button type="button" id="save-availability-btn" class="btn">Save Availability</button><span id="avail-status" class="save-status"></span></div>
    </div>

    ${hasAnyFields ? `<div class="card" style="padding:1.25rem;margin-bottom:16px;">
      <h4>Details</h4>
      <div class="speaker-form">
        ${showSummary ? `<div class="form-group"><label>Talk Summary</label><textarea id="speaker-summary" rows="4" placeholder="Brief summary...">${esc(speaker.talkSummary || '')}</textarea></div>` : ''}
        ${showQuestions ? `<div class="form-group"><label>Discussion Questions</label>
          <p class="muted-text" style="margin:0 0 8px;font-size:.85rem;">Three questions for discussion.</p>
          <input type="text" id="speaker-q1" placeholder="Question 1" value="${esc(questions[0] || '')}" />
          <input type="text" id="speaker-q2" placeholder="Question 2" value="${esc(questions[1] || '')}" style="margin-top:8px;" />
          <input type="text" id="speaker-q3" placeholder="Question 3" value="${esc(questions[2] || '')}" style="margin-top:8px;" />
        </div>` : ''}
        ${showLink ? `<div class="form-group"><label>Presentation Materials Link</label><input type="url" id="speaker-link" placeholder="https://..." value="${esc(speaker.presentationLink || '')}" /></div>` : ''}
        <button type="button" id="save-speaker-info-btn" class="btn">Save Details</button><span id="speaker-info-status" class="save-status"></span>
      </div>
    </div>` : ''}
  `;
}

/* ─── Admin View ──────────────────────────────────────────── */
function adminViewHTML(config) {
  const schedule = config.schedule;
  const speakers = config.speakers;
  const expanded = expandSchedule(schedule);
  const dl = daysLabel(expanded.days);
  const mode = schedule.mode || 'sessions';
  const hasSchedule = expanded.days.length > 0 && (mode === 'freeform' ? expanded.blocks?.length > 0 : expanded.slots?.length > 0);

  const gridStr = hasSchedule
    ? (mode === 'freeform' ? freeformGridHTML(expanded, speakers, true) : sessionsGridHTML(expanded, speakers, true))
    : '';

  const allSlots = expanded.allSlots || [];
  let guestTableHTML = '';
  if (!speakers.length) {
    guestTableHTML = '<p class="muted-text">No guests added yet.</p>';
  } else {
    guestTableHTML = '<div style="overflow-x:auto;"><table class="scheduler-table"><thead><tr><th>Name</th><th>Email</th><th>Avail</th>';
    if (mode === 'sessions') guestTableHTML += '<th>Assigned</th>';
    guestTableHTML += '<th>Invite</th><th></th></tr></thead><tbody>';
    speakers.forEach(sp => {
      const ac = (sp.availability || []).length;
      const totalSlots = mode === 'sessions' ? allSlots.length : '—';
      const inviteURL = config.buildInviteURL ? config.buildInviteURL(config.scheduleId, sp.key || sp.id) : '';
      guestTableHTML += `<tr><td>${esc(sp.speakerName)}</td><td>${esc(sp.speakerEmail || '')}</td><td>${ac}${totalSlots !== '—' ? ' / ' + totalSlots : ''}</td>`;
      if (mode === 'sessions') guestTableHTML += `<td>${sp.assignedSlot ? esc(slotLabel(sp.assignedSlot, allSlots)) : '<em>—</em>'}</td>`;
      guestTableHTML += `<td><button class="btn btn-small copy-invite-btn" data-invite-url="${esc(inviteURL)}">Copy Link</button></td><td>`;
      if (mode === 'sessions') guestTableHTML += `<select class="assign-select" data-speaker-id="${sp.id}"><option value="">—</option>${allSlots.map(s => `<option value="${s.id}" ${sp.assignedSlot === s.id ? 'selected' : ''} ${(sp.availability || []).includes(s.id) ? '' : 'disabled'}>${s.day.label} ${s.slot.label}</option>`).join('')}</select>`;
      guestTableHTML += `<button class="btn btn-danger btn-small" data-remove-speaker="${sp.id}" style="margin-left:4px;">Remove</button></td></tr>`;
    });
    guestTableHTML += '</tbody></table></div>';
  }

  const unassignedWithAvail = mode === 'sessions' && speakers.some(s => !s.assignedSlot && (s.availability || []).length > 0);

  return `
    ${hasSchedule ? `
      <h4>Schedule${dl ? ' — ' + dl : ''}</h4>
      <div id="schedule-grid-container">${gridStr}</div>
    ` : '<p class="muted-text" style="margin-bottom:16px;">Set up your schedule below to get started.</p>'}

    <h4 style="margin-top:20px;">Guests</h4>
    <div class="form-row" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;">
      <input type="text" id="add-speaker-name" placeholder="Guest name" style="flex:1;min-width:140px;" />
      <input type="email" id="add-speaker-email" placeholder="Guest email" style="flex:1;min-width:180px;" />
      <button type="button" id="add-speaker-btn" class="btn">Add Guest</button>
    </div>
    <div id="speakers-list-admin">${guestTableHTML}</div>
    ${unassignedWithAvail ? '<div style="margin-top:12px;"><button type="button" id="optimize-btn" class="btn btn-secondary">Auto-Assign Slots</button></div>' : ''}
    <div id="optimization-result"></div>

    <details style="margin-top:24px;">
      <summary style="cursor:pointer;font-weight:600;font-size:.95rem;">Schedule Settings</summary>
      <div id="schedule-setup-form" style="margin-top:12px;"></div>
    </details>
  `;
}

/* ================================================================
   SETUP FORM — session builder or freeform config
   ================================================================ */
function setupFormHTML(schedule) {
  const mode = schedule.mode || 'sessions';

  return `
    <div class="speaker-form">
      <div class="form-group"><label>Title</label>
        <input type="text" id="setup-sched-title" value="${esc(schedule.title || '')}" placeholder="Scheduler title" />
      </div>
      <div class="form-group"><label>Description</label>
        <textarea id="setup-sched-desc" rows="2" placeholder="Brief description (optional)">${esc(schedule.description || '')}</textarea>
      </div>

      <div class="form-group"><label>Mode</label>
        <div class="mode-toggle">
          <button type="button" class="mode-btn ${mode === 'sessions' ? 'mode-active' : ''}" data-mode="sessions">Sessions</button>
          <button type="button" class="mode-btn ${mode === 'freeform' ? 'mode-active' : ''}" data-mode="freeform">Freeform</button>
        </div>
        <p class="muted-text" style="font-size:.8rem;margin:6px 0 0;">Sessions: place fixed time blocks on specific days. Freeform: guests paint their own availability.</p>
      </div>

      <div id="builder-root"></div>

      <div class="form-group" style="margin-top:12px;">
        <label style="font-weight:600;">Guest Fields</label>
        <p class="muted-text" style="font-size:.8rem;margin:0 0 8px;">Optional fields shown to guests (all off = bare-bones availability only).</p>
        <label class="sched-toggle"><input type="checkbox" id="gf-talkSummary" ${(schedule.guestFields || []).includes('talkSummary') ? 'checked' : ''} /> Talk Summary</label>
        <label class="sched-toggle"><input type="checkbox" id="gf-questions" ${(schedule.guestFields || []).includes('questions') ? 'checked' : ''} /> Discussion Questions</label>
        <label class="sched-toggle"><input type="checkbox" id="gf-presentationLink" ${(schedule.guestFields || []).includes('presentationLink') ? 'checked' : ''} /> Presentation Materials Link</label>
      </div>

      <div class="form-group" style="margin-top:12px;">
        <label style="font-weight:600;">Guest Instructions</label>
        <p class="muted-text" style="font-size:.8rem;margin:0 0 8px;">Custom instructions shown to guests in the welcome block. Leave blank for auto-generated defaults.</p>
        <textarea id="setup-guest-instructions" rows="4" placeholder="Instructions for your guests...">${esc(schedule.guestInstructions || '')}</textarea>
        <button type="button" id="reset-instructions-btn" class="btn btn-small btn-secondary" style="margin-top:6px;">Reset to Default</button>
      </div>

      <button type="button" id="save-schedule-setup-btn" class="btn" style="margin-top:12px;">Save Settings</button>
      <span id="setup-save-status" class="save-status"></span>
    </div>
  `;
}

function updateDaysSummary(elId, days) {
  const el = document.getElementById(elId);
  if (!el) return;
  if (!days.length) { el.innerHTML = '<span class="muted-text">No days selected.</span>'; return; }
  el.innerHTML = '<strong>' + days.length + ' day' + (days.length !== 1 ? 's' : '') + ':</strong> ' +
    days.sort().map(d => dateLabel(d)).join(', ');
}

/* ================================================================
   TOP-LEVEL API: render + wire
   ================================================================ */
function render(config) {
  const vt = normalizeView(config.viewType);
  const avm = normalizeView(config.adminViewMode);
  const { speakers, currentSpeaker, previewSpeakerIdx } = config;

  if (vt === 'admin') {
    const switcher = viewSwitcherHTML(avm || 'admin', speakers, previewSpeakerIdx || 0);
    let body;
    if (avm === 'public') {
      body = publicViewHTML(config);
    } else if (avm === 'guest') {
      const sp = currentSpeaker || speakers[previewSpeakerIdx || 0] || speakers[0];
      if (sp) {
        const isOwn = currentSpeaker && sp.id === currentSpeaker.id;
        const banner = isOwn ? '' : `<p class="muted-text" style="font-size:.85rem;margin-bottom:12px;"><em>Previewing as ${esc(sp.speakerName)}</em></p>`;
        body = banner + guestViewHTML({ ...config, currentSpeaker: sp });
      } else {
        body = '<p class="muted-text">No guests added yet.</p>';
      }
    } else {
      body = adminViewHTML(config);
    }
    return switcher + body;
  }

  if (vt === 'guest' && currentSpeaker) {
    return guestViewHTML(config);
  }

  return publicViewHTML(config);
}

function wire(containerId, config) {
  const vt = normalizeView(config.viewType);
  const avm = normalizeView(config.adminViewMode);
  const { schedule, speakers, currentSpeaker, useKeyAuth, scheduleId, previewSpeakerIdx } = config;
  const mode = schedule.mode || 'sessions';
  const expanded = expandSchedule(schedule);

  // View switcher (admin only)
  if (vt === 'admin') {
    document.querySelectorAll('[data-view-mode]').forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.dataset.viewMode === (avm || 'admin')) return;
        if (config.onSwitchView) config.onSwitchView(btn.dataset.viewMode, 0);
      });
    });
    document.getElementById('preview-speaker-select')?.addEventListener('change', e => {
      if (config.onSwitchView) config.onSwitchView('guest', parseInt(e.target.value) || 0);
    });
  }

  // Public view — no wiring
  if (vt !== 'admin' && vt !== 'guest') return;
  if (vt === 'admin' && avm === 'public') return;

  // Guest form
  if ((vt === 'guest' && currentSpeaker) || (vt === 'admin' && avm === 'guest')) {
    const sp = vt === 'guest' ? currentSpeaker : (currentSpeaker || speakers[previewSpeakerIdx || 0] || speakers[0]);
    if (sp) {
      const isOwn = vt === 'guest' || (currentSpeaker && sp.id === currentSpeaker.id);
      if (isOwn) wireGuestForm(sp, schedule, expanded, config);
    }
    return;
  }

  // Admin view
  if (vt === 'admin' && (!avm || avm === 'admin')) {
    wireAdminAll(config, expanded);
  }
}

/* ─── Wire: Guest form & availability ────────────────────── */
function wireGuestForm(speaker, schedule, expanded, config) {
  const mode = schedule.mode || 'sessions';
  const saveFn = async (data) => {
    if (config.onSaveSpeaker) await config.onSaveSpeaker(speaker.id, data, config.useKeyAuth);
  };

  if (mode === 'sessions') {
    document.getElementById('save-availability-btn')?.addEventListener('click', async () => {
      const st = document.getElementById('avail-status');
      st.textContent = 'Saving...';
      try {
        const checked = [];
        document.querySelectorAll('.avail-checkbox:checked').forEach(cb => checked.push(cb.dataset.slot));
        await saveFn({ availability: checked });
        st.textContent = 'Saved!'; setTimeout(() => { st.textContent = ''; }, 2000);
      } catch (e) { st.textContent = 'Error.'; console.error(e); }
    });
  } else {
    wireFreeformDrag('speaker-avail-grid', speaker.availability || [], async (selected) => {
      await saveFn({ availability: selected });
    });
  }

  // Details form (only wired if guest fields are enabled)
  document.getElementById('save-speaker-info-btn')?.addEventListener('click', async () => {
    const st = document.getElementById('speaker-info-status');
    st.textContent = 'Saving...';
    try {
      const data = {};
      const summaryEl = document.getElementById('speaker-summary');
      if (summaryEl) data.talkSummary = summaryEl.value.trim();
      const q1 = document.getElementById('speaker-q1'), q2 = document.getElementById('speaker-q2'), q3 = document.getElementById('speaker-q3');
      if (q1) data.questions = [q1.value.trim(), q2?.value.trim() || '', q3?.value.trim() || ''];
      const linkEl = document.getElementById('speaker-link');
      if (linkEl) data.presentationLink = linkEl.value.trim();
      await saveFn(data);
      st.textContent = 'Saved!'; setTimeout(() => { st.textContent = ''; }, 2000);
    } catch (e) { st.textContent = 'Error.'; console.error(e); }
  });
}

/* ─── Wire: Admin controls ────────────────────────────────── */
function wireAdminAll(config, expanded) {
  const { schedule, speakers, scheduleId } = config;
  const mode = schedule.mode || 'sessions';
  const allSlots = expanded.allSlots || [];

  // Setup form
  wireSetupForm(config);

  // Copy invite links
  document.querySelectorAll('.copy-invite-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      navigator.clipboard.writeText(btn.dataset.inviteUrl)
        .then(() => { btn.textContent = 'Copied!'; setTimeout(() => { btn.textContent = 'Copy Link'; }, 2000); })
        .catch(() => prompt('Copy:', btn.dataset.inviteUrl));
    });
  });

  // Assign select (sessions)
  document.querySelectorAll('.assign-select').forEach(sel => {
    sel.addEventListener('change', async () => {
      try {
        if (config.onSaveSpeaker) await config.onSaveSpeaker(sel.dataset.speakerId, { assignedSlot: sel.value || null });
        if (config.onRefresh) await config.onRefresh();
      } catch (e) { alert('Failed.'); }
    });
  });

  // Remove guest
  document.querySelectorAll('[data-remove-speaker]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Remove this guest?')) return;
      try {
        if (config.onDeleteSpeaker) await config.onDeleteSpeaker(btn.dataset.removeSpeaker);
        if (config.onRefresh) await config.onRefresh();
      } catch (e) { alert('Failed.'); }
    });
  });

  // Add guest
  document.getElementById('add-speaker-btn')?.addEventListener('click', async () => {
    const nameEl = document.getElementById('add-speaker-name'), emailEl = document.getElementById('add-speaker-email');
    const name = nameEl.value.trim(), email = emailEl.value.trim().toLowerCase();
    if (!name) { alert('Enter a name.'); return; }
    if (speakers.find(s => s.speakerEmail?.toLowerCase() === email && email)) { alert('Guest already exists.'); return; }
    try {
      if (config.onAddSpeaker) await config.onAddSpeaker({ scheduleId, speakerName: name, speakerEmail: email, speakerUid: null, availability: [], assignedSlot: null });
      nameEl.value = ''; emailEl.value = '';
      if (config.onRefresh) await config.onRefresh();
    } catch (e) { alert('Failed.'); console.error(e); }
  });

  // Optimization (sessions only)
  if (mode === 'sessions') {
    document.getElementById('optimize-btn')?.addEventListener('click', () => {
      const result = optimizeSchedule(speakers);
      renderOptimizationResult(result, allSlots, config);
    });
  }
}

function renderOptimizationResult(result, allSlots, config) {
  const el = document.getElementById('optimization-result');
  if (!el) return;
  if (!result.length) { el.innerHTML = '<p class="muted-text">No guests with availability.</p>'; return; }
  let html = '<h4 style="margin-top:16px;">Suggested Assignment</h4><div style="overflow-x:auto;"><table class="scheduler-table"><thead><tr><th>#</th><th>Guest</th><th>Slot</th><th>Notes</th><th></th></tr></thead><tbody>';
  result.forEach((r, i) => {
    html += `<tr><td>${i + 1}</td><td>${esc(r.speaker.speakerName)}</td><td>${r.slot ? esc(slotLabel(r.slot, allSlots)) : '<em>—</em>'}</td><td class="muted-text">${esc(r.reason)}</td><td>${r.slot ? `<button class="btn btn-small" data-apply-slot="${r.speaker.id}" data-slot-value="${r.slot}">Apply</button>` : ''}</td></tr>`;
  });
  html += '</tbody></table></div><button type="button" id="apply-all-btn" class="btn" style="margin-top:12px;">Apply All</button>';
  el.innerHTML = html;

  el.querySelectorAll('[data-apply-slot]').forEach(btn => {
    btn.addEventListener('click', async () => {
      try {
        if (config.onSaveSpeaker) await config.onSaveSpeaker(btn.dataset.applySlot, { assignedSlot: btn.dataset.slotValue });
        btn.textContent = 'Done'; btn.disabled = true;
      } catch (e) { console.error(e); }
    });
  });

  document.getElementById('apply-all-btn')?.addEventListener('click', async () => {
    const btn = document.getElementById('apply-all-btn'); btn.textContent = 'Applying...'; btn.disabled = true;
    try {
      for (const r of result) if (r.slot && config.onSaveSpeaker) await config.onSaveSpeaker(r.speaker.id, { assignedSlot: r.slot });
      if (config.onRefresh) await config.onRefresh();
    } catch (e) { alert('Error.'); }
  });
}

/* ─── Wire: Schedule setup form ───────────────────────────── */
function wireSetupForm(config) {
  const form = document.getElementById('schedule-setup-form') || document.getElementById('class-details-form');
  if (!form) return;
  const schedule = config.schedule;
  let currentMode = schedule.mode || 'sessions';
  let builderApi = null;

  // Derive initial freeform cells from schedule data
  const initFFCells = schedule.freeformCells || [];
  const initSelectedDays = [...(schedule.selectedDays || [])];
  const initSessionBlocks = schedule.sessionBlocks ? JSON.parse(JSON.stringify(schedule.sessionBlocks)) : [];

  form.innerHTML = setupFormHTML(schedule);

  function mountBuilder(mode) {
    const root = document.getElementById('builder-root');
    if (!root) return;
    root.innerHTML = builderHTML(mode, mode === 'sessions' ? initSessionBlocks : [], initSelectedDays);
    builderApi = wireBuilder('builder-root', mode,
      mode === 'sessions' ? initSessionBlocks : [],
      mode === 'freeform' ? initFFCells : [],
      schedule.sessionDuration || 60,
      () => {} // onChange — state tracked via builderApi getters
    );
  }

  mountBuilder(currentMode);

  // Mode toggle
  form.querySelectorAll('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.mode === currentMode) return;
      form.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('mode-active'));
      btn.classList.add('mode-active');
      currentMode = btn.dataset.mode;
      mountBuilder(currentMode);
    });
  });

  // Reset guest instructions to auto-generated default
  document.getElementById('reset-instructions-btn')?.addEventListener('click', () => {
    const gf = [];
    if (document.getElementById('gf-talkSummary')?.checked) gf.push('talkSummary');
    if (document.getElementById('gf-questions')?.checked) gf.push('questions');
    if (document.getElementById('gf-presentationLink')?.checked) gf.push('presentationLink');
    const ta = document.getElementById('setup-guest-instructions');
    if (ta) ta.value = defaultGuestInstructions(gf, currentMode);
  });

  // Save
  document.getElementById('save-schedule-setup-btn')?.addEventListener('click', async () => {
    const st = document.getElementById('setup-save-status');
    st.textContent = 'Saving...';

    const activeMode = currentMode;
    const api = builderApi;

    // Gather guest field toggles
    const guestFields = [];
    if (document.getElementById('gf-talkSummary')?.checked) guestFields.push('talkSummary');
    if (document.getElementById('gf-questions')?.checked) guestFields.push('questions');
    if (document.getElementById('gf-presentationLink')?.checked) guestFields.push('presentationLink');

    let selectedDays, slotDefs, sessionBlocks, freeformCells, sessionDuration;
    if (activeMode === 'sessions' && api) {
      sessionBlocks = api.getBlocks();
      const daySet = new Set();
      const slotSet = new Map();
      sessionBlocks.forEach(sb => {
        if (sb.day) daySet.add(sb.day);
        const key = `${sb.start}-${sb.end}`;
        if (!slotSet.has(key)) slotSet.set(key, { start: sb.start, end: sb.end });
      });
      selectedDays = [...daySet].sort();
      slotDefs = [...slotSet.values()].sort((a, b) => timeToMinutes(a.start) - timeToMinutes(b.start));
      freeformCells = [];
      sessionDuration = api.getDuration();
    } else if (api) {
      selectedDays = api.getDays();
      freeformCells = api.getCells();
      sessionBlocks = [];
      slotDefs = [];
      sessionDuration = 0;
    } else {
      selectedDays = []; slotDefs = []; sessionBlocks = []; freeformCells = []; sessionDuration = 60;
    }

    const data = {
      id: config.scheduleId,
      title: document.getElementById('setup-sched-title')?.value.trim() || '',
      description: document.getElementById('setup-sched-desc')?.value.trim() || '',
      guestInstructions: document.getElementById('setup-guest-instructions')?.value.trim() || '',
      mode: activeMode,
      sessionBlocks,
      freeformCells,
      sessionDuration,
      selectedDays,
      startDate: selectedDays[0] || '',
      endDate: selectedDays[selectedDays.length - 1] || '',
      slotDefs,
      guestFields,
      startHour: 7,
      endHour: 21,
      granularity: 15
    };
    try {
      if (config.onSaveSchedule) await config.onSaveSchedule(data);
      st.textContent = 'Saved!'; setTimeout(() => { st.textContent = ''; }, 2000);
      if (config.onRefresh) await config.onRefresh();
    } catch (e) { st.textContent = 'Error.'; console.error(e); }
  });
}

/* ================================================================
   EXPORTS
   ================================================================ */
McgheeLab.Scheduler = {
  render,
  wire,
  renderGrid: gridHTML,
  renderSetupForm: setupFormHTML,
  wireSetupForm,
  renderBuilder: builderHTML,
  wireBuilder,
  renderConfirmedSpeakers: confirmedSpeakersHTML,
  expandSchedule,
  optimizeSchedule,
  heatColor,
  fmtTime,
  slotLabel
};

})();
