/* ================================================================
   schedule-utils.js — Shared time/week utility functions
   ================================================================
   Pure utility functions used by the Huddle (plans + team availability)
   and the Scheduler app (My Schedule). No state, no side effects.

   Loaded via <script defer> in each app's index.html.
   Exposes McgheeLab.ScheduleUtils on the global namespace.
   ================================================================ */

window.McgheeLab = window.McgheeLab || {};

McgheeLab.ScheduleUtils = (() => {
  'use strict';

  /* ─── Date Helpers ───────────────────────────────────────── */

  function localDateStr(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function todayStr() { return localDateStr(new Date()); }

  /* ─── Week Helpers ───────────────────────────────────────── */

  function getMonday(offset) {
    const d = new Date();
    const day = d.getDay();
    d.setDate(d.getDate() - day + 1 + (offset * 7));
    return d;
  }

  function getWeekId(offset) {
    const mon = getMonday(offset);
    const tmp = new Date(mon.getTime());
    tmp.setDate(tmp.getDate() + 3 - ((tmp.getDay() + 6) % 7));
    const jan4 = new Date(tmp.getFullYear(), 0, 4);
    const weekNum = 1 + Math.round(((tmp - jan4) / 86400000 - 3 + ((jan4.getDay() + 6) % 7)) / 7);
    return tmp.getFullYear() + '-W' + String(weekNum).padStart(2, '0');
  }

  function currentWeekId(offset) { return getWeekId(offset || 0); }

  function getWeekDays(offset) {
    const mon = getMonday(offset);
    const days = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(mon);
      d.setDate(mon.getDate() + i);
      days.push({
        date: localDateStr(d),
        dayName: d.toLocaleDateString('en-US', { weekday: 'long' }),
        dayShort: d.toLocaleDateString('en-US', { weekday: 'short' }),
        monthDay: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      });
    }
    return days;
  }

  function getWeekLabel(offset) {
    const days = getWeekDays(offset);
    const s = days[0], e = days[6];
    if (offset === 0) return 'This Week: ' + s.monthDay + ' \u2013 ' + e.monthDay;
    if (offset === -1) return 'Last Week: ' + s.monthDay + ' \u2013 ' + e.monthDay;
    if (offset === 1) return 'Next Week: ' + s.monthDay + ' \u2013 ' + e.monthDay;
    return s.monthDay + ' \u2013 ' + e.monthDay;
  }

  /* ─── Time Helpers ───────────────────────────────────────── */

  function fmtTime(t) {
    if (!t) return '';
    const [h, m] = t.split(':');
    const hr = parseInt(h);
    const suffix = hr >= 12 ? 'PM' : 'AM';
    return ((hr % 12) || 12) + ':' + m + ' ' + suffix;
  }

  function timeToSlot(timeStr, startHour) {
    if (!timeStr) return 0;
    const [h, m] = timeStr.split(':').map(Number);
    return (h - startHour) * 2 + (m >= 30 ? 1 : 0);
  }

  function slotToTime(slot, startHour) {
    const h = startHour + Math.floor(slot / 2);
    const m = (slot % 2) * 30;
    return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
  }

  function timeLabels(startHour, endHour) {
    const labels = [];
    for (let h = startHour; h < endHour; h++) {
      labels.push({ time: String(h).padStart(2, '0') + ':00', label: fmtTime(String(h).padStart(2, '0') + ':00') });
      labels.push({ time: String(h).padStart(2, '0') + ':30', label: '' });
    }
    return labels;
  }

  /** Convert calendar time strings ("2:30 PM", "14:30") to "HH:MM" format */
  function parseCalTimeToHHMM(timeStr) {
    if (!timeStr) return null;
    if (/^\d{2}:\d{2}$/.test(timeStr)) return timeStr;
    const m = timeStr.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
    if (!m) return null;
    let h = parseInt(m[1]);
    const min = m[2];
    if (m[3].toUpperCase() === 'PM' && h < 12) h += 12;
    if (m[3].toUpperCase() === 'AM' && h === 12) h = 0;
    return String(h).padStart(2, '0') + ':' + min;
  }

  /* ─── Display Helpers ────────────────────────────────────── */

  function escHTML(str) {
    if (!str) return '';
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  /* ─── Zoom Levels ────────────────────────────────────────── */
  const ZOOM_LEVELS = [4, 6, 9, 14, 20, 28, 40, 56, 76]; // px per half-hour slot

  /* ─── Per-User Colors ────────────────────────────────────── */
  const USER_COLORS = [
    '#5baed1', '#86efac', '#c4b5fd', '#fbbf24', '#f472b6',
    '#38bdf8', '#a78bfa', '#fb923c', '#34d399', '#f87171',
    '#818cf8', '#facc15', '#2dd4bf', '#e879f9', '#94a3b8'
  ];
  const _userColorMap = new Map();
  function getUserColor(uid) {
    if (!_userColorMap.has(uid)) _userColorMap.set(uid, USER_COLORS[_userColorMap.size % USER_COLORS.length]);
    return _userColorMap.get(uid);
  }

  /* ─── Public API ─────────────────────────────────────────── */
  return {
    localDateStr,
    todayStr,
    getMonday,
    getWeekId,
    currentWeekId,
    getWeekDays,
    getWeekLabel,
    fmtTime,
    timeToSlot,
    slotToTime,
    timeLabels,
    parseCalTimeToHHMM,
    escHTML,
    ZOOM_LEVELS,
    USER_COLORS,
    getUserColor
  };
})();
