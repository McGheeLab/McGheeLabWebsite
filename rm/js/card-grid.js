/* card-grid.js — shared primitives for pin-grid card layouts.
 *
 * Lifts the reusable helpers from tasks-dashboard-buckets.js so research /
 * teaching / service / archive / inbox can render the same card chrome.
 *
 * Keeps every function pure (or near-pure) — no DOM globals, no state,
 * no fetches. Callers wire these into their own render loops.
 *
 * Exposes: window.CARD_GRID
 *   sumHours(node)              — node.hours_estimate + Σ children
 *   aggregateDue(node)          — earliest non-TBD due date across self + open descendants
 *   duePrefix(date)             — '' | 'due-soon' | 'due-overdue'
 *   pacingFor(node)             — { hours, days, load, level, label, tooltip } | null
 *   appendChips(container, st)  — paint the standard chip row (due/priority/hours/pacing/evidence)
 *   itemColor(item)             — item.color || CAT_COLOR[item.category] || fallback
 *   PROJECT_COLORS              — palette for the color picker
 *
 * Depends on window.YR_SHARED (todayStr, CAT_COLOR).
 */

(function () {
  const YR = window.YR_SHARED || {};
  const CAT_COLOR = YR.CAT_COLOR || {};
  const todayStr = YR.todayStr || (() => new Date().toISOString().slice(0, 10));

  const PROJECT_COLORS = [
    '#1e40af', // research blue
    '#92400e', // teaching amber
    '#5b21b6', // service violet
    '#374151', // admin slate
    '#991b1b', // personal red
    '#047857', // green
    '#0e7490', // cyan
    '#be185d', // pink
    '#a16207', // gold
    '#1f2937', // near-black
  ];

  function itemColor(item) {
    if (item && item.color) return item.color;
    if (item && item.category && CAT_COLOR[item.category]) return CAT_COLOR[item.category];
    return '#6b7280';
  }

  function sumHours(node) {
    let h = Number(node && node.hours_estimate) || 0;
    for (const c of (node && node.children) || []) h += sumHours(c);
    return h;
  }

  function aggregateDue(node) {
    let earliest = null;
    function walk(n) {
      if (!n) return;
      if (!n.done && n.due_date && n.due_date !== 'TBD') {
        if (!earliest || n.due_date < earliest) earliest = n.due_date;
      }
      for (const c of n.children || []) walk(c);
    }
    walk(node);
    return earliest;
  }

  function duePrefix(date) {
    if (!date || date === 'TBD') return '';
    const today = todayStr();
    if (date < today) return 'due-overdue';
    const d = new Date(date).getTime();
    const t = new Date(today).getTime();
    if ((d - t) / 86400000 <= 3) return 'due-soon';
    return '';
  }

  // Hours/day required: 20h/3d (~6.7) is RED, 20h/7d (~2.9) is YELLOW.
  function pacingFor(node) {
    if (!node || node.done) return null;
    const due = aggregateDue(node);
    if (!due) return null;
    const hours = sumHours(node);
    if (hours <= 0) return null;
    const today = new Date(todayStr());
    const dueD  = new Date(due);
    const msPerDay = 86400000;
    const rawDays = Math.floor((dueD - today) / msPerDay);
    if (rawDays < 0) {
      return { hours, days: 0, load: Infinity, level: 'red',
               label: `↯ ${hours.toFixed(1)}h overdue`,
               tooltip: `${hours.toFixed(1)}h estimated, but the due date has already passed.` };
    }
    const days = Math.max(1, rawDays);
    const load = hours / days;
    let level, prefix;
    if (load >= 5)      { level = 'red';    prefix = '↯ '; }
    else if (load >= 3) { level = 'orange'; prefix = '⚠ '; }
    else if (load >= 1) { level = 'yellow'; prefix = '· '; }
    else                { level = 'green';  prefix = '· '; }
    const dayWord = days === 1 ? 'day' : 'days';
    return {
      hours, days, load, level,
      label: `${prefix}${load.toFixed(1)}h/d`,
      tooltip:
        `${hours.toFixed(1)}h estimated · ${days} ${dayWord} until due (${due})\n` +
        `→ requires ${load.toFixed(1)}h/day` +
        (level === 'red'    ? ' — extremely difficult, would dominate every day' :
         level === 'orange' ? ' — hard, will crowd out other work'              :
         level === 'yellow' ? ' — manageable but needs daily pacing'            :
                              ' — comfortable'),
    };
  }

  function appendChips(container, st) {
    const dueDate = aggregateDue(st) || (st.due_date && st.due_date !== 'TBD' ? st.due_date : '');
    if (dueDate) {
      const c = document.createElement('span');
      const cls = duePrefix(dueDate);
      c.style.cssText = 'font-size:11px;padding:1px 7px;border-radius:10px;font-variant-numeric:tabular-nums;flex-shrink:0;';
      if (cls === 'due-overdue') { c.style.background = '#fecaca'; c.style.color = '#7f1d1d'; }
      else if (cls === 'due-soon') { c.style.background = '#fef3c7'; c.style.color = '#92400e'; }
      else { c.style.background = '#f3f4f6'; c.style.color = '#374151'; }
      c.textContent = dueDate.slice(5);
      if (dueDate !== st.due_date) c.title = `Earliest open deadline in subtree: ${dueDate}`;
      container.appendChild(c);
    }
    if (st.priority && st.priority !== 'normal') {
      const c = document.createElement('span');
      c.style.cssText = 'font-size:10px;padding:1px 7px;border-radius:10px;font-weight:700;text-transform:uppercase;background:#fee2e2;color:#7f1d1d;flex-shrink:0';
      c.textContent = st.priority;
      container.appendChild(c);
    }
    const totalHrs = sumHours(st);
    const selfHrs = Number(st.hours_estimate) || 0;
    if (totalHrs > 0) {
      const c = document.createElement('span');
      c.style.cssText = 'font-size:11px;padding:1px 7px;border-radius:10px;background:#e0e7ff;color:#3730a3;flex-shrink:0';
      c.textContent = `${totalHrs.toFixed(2).replace(/\.?0+$/, '')}h`;
      if (totalHrs !== selfHrs) c.title = `Total ${totalHrs}h = self ${selfHrs}h + ${totalHrs - selfHrs}h in subtasks`;
      container.appendChild(c);
    }
    const pace = pacingFor(st);
    if (pace) {
      const c = document.createElement('span');
      const palette = {
        green:  ['#dcfce7', '#166534'],
        yellow: ['#fef3c7', '#854d0e'],
        orange: ['#fed7aa', '#9a3412'],
        red:    ['#fecaca', '#7f1d1d'],
      };
      const [bg, fg] = palette[pace.level];
      c.style.cssText = `font-size:11px;padding:1px 7px;border-radius:10px;background:${bg};color:${fg};font-weight:700;flex-shrink:0`;
      c.textContent = pace.label;
      c.title = pace.tooltip;
      container.appendChild(c);
    }
    const ev = st.evidence || {};
    const eCount = (ev.email_ids || []).length + (ev.event_ids || []).length + (ev.item_ids || []).length;
    if (eCount) {
      const c = document.createElement('span');
      c.style.cssText = 'font-size:11px;padding:1px 7px;border-radius:10px;background:#ede9fe;color:#5b21b6;flex-shrink:0';
      const parts = [];
      if ((ev.email_ids || []).length) parts.push(`${ev.email_ids.length}m`);
      if ((ev.event_ids || []).length) parts.push(`${ev.event_ids.length}e`);
      if ((ev.item_ids || []).length) parts.push(`${ev.item_ids.length}i`);
      c.textContent = parts.join(' ');
      container.appendChild(c);
    }
  }

  window.CARD_GRID = {
    PROJECT_COLORS,
    itemColor,
    sumHours,
    aggregateDue,
    duePrefix,
    pacingFor,
    appendChips,
  };
})();
