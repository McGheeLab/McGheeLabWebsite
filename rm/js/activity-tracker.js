/* activity-tracker.js — the single activity surface (V3.320, FuturePlan 04 B2).
 *
 * Complete rewrite of the 2152-line hours-centric tracker. Hours are
 * dead (V3.319): activity is auto-captured as lightweight events by
 * page-time-tracker.js + the recordWork producers, so this page only
 * PRESENTS — it never asks the user to log or confirm anything.
 *
 * Surface (mounted at #tracker-root inside activity-overview.html?tab=tracker):
 *   · GitHub-style calendar heatmap — 53 weeks, shade = events/day
 *   · current + best streaks (days with ≥1 work event)
 *   · per-category counts for a 7/30/90-day range
 *   · recent-activity feed + "Coming up" lane (schedule events)
 *   · one minimal quick-log input → a `manual` work event
 *
 * Data: ONE ActivitySignals.listEvents(uid, {from: today-53w}) read.
 * Both event shapes come back — new events (kind:'work'|'schedule', no
 * status) and legacy hours-era entries (status confirmed/pending). A
 * doc counts as work unless it's a schedule marker (kind:'schedule',
 * or legacy pending with scheduled_for).
 *
 * Deleted with this rewrite: daily hours view + pending banner, voice
 * input, AI bulk-parse, Anthropic categorize, Naive Bayes ML, weekly
 * drag-drop planner, analytics charts, category manager, hours-centric
 * settings, huddle/calendar-suggest integrations. (shareActivity lives
 * on the Settings page profile tab since V3.48.)
 */
(function () {
  'use strict';

  const root = document.getElementById('tracker-root');
  if (!root) {
    console.warn('[ActivityTracker] #tracker-root container missing');
    return;
  }

  const state = {
    me: null,
    events: [],          // everything from listEvents (53 weeks)
    rangeDays: 30,       // category counts + feed range
  };

  /* ── date helpers ─────────────────────────────────────────────── */

  function localDateStr(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + dd;
  }
  function todayStr() { return localDateStr(new Date()); }
  function offsetDate(dateStr, days) {
    const d = new Date(dateStr + 'T12:00:00');
    d.setDate(d.getDate() + days);
    return localDateStr(d);
  }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* ── event classification ─────────────────────────────────────── */

  function isScheduleMarker(e) {
    if (e.kind === 'schedule') return true;
    if (!e.kind && e.scheduled_for && e.status === 'pending') return true;
    return false;
  }
  function isWorkEvent(e) { return !isScheduleMarker(e); }

  const CATEGORY_LABELS = {
    'research':   'Research',
    'admin':      'Admin',
    'page-time':  'Active on RM',
    'admin-work': 'Admin',
    'manual':     'Logged by hand',
  };
  function categoryOf(e) {
    if (Array.isArray(e.categoryPath) && e.categoryPath.length) {
      // Two levels max — 'research › notebook' reads better than a
      // deep tree, and the producers only stamp two.
      return e.categoryPath.slice(0, 2).join(' › ');
    }
    if (e.source === 'rm-page-time') {
      return (e.source_ref && e.source_ref.kind === 'admin-work') ? 'Admin' : 'Active on RM';
    }
    const s = String(e.source || '').replace(/^rm-/, '');
    return CATEGORY_LABELS[s] || s || 'other';
  }
  function prettyCategory(c) {
    return CATEGORY_LABELS[c] || c.replace(/\b\w/g, ch => ch.toUpperCase());
  }

  /* ── aggregation ──────────────────────────────────────────────── */

  function dayCounts() {
    const map = {};
    state.events.forEach(function (e) {
      if (!isWorkEvent(e) || !e.date) return;
      map[e.date] = (map[e.date] || 0) + 1;
    });
    return map;
  }

  function streaks(counts) {
    const today = todayStr();
    // current: walk back from today; an empty today doesn't break the
    // streak (the day isn't over yet).
    let current = 0;
    let d = today;
    if (!counts[d]) d = offsetDate(d, -1);
    while (counts[d]) { current++; d = offsetDate(d, -1); }
    // best: walk the whole loaded window.
    let best = 0, run = 0;
    const start = offsetDate(today, -371);
    for (let day = start; day <= today; day = offsetDate(day, 1)) {
      if (counts[day]) { run++; if (run > best) best = run; }
      else run = 0;
    }
    return { current: current, best: Math.max(best, current) };
  }

  function level(count) {
    if (!count) return 0;
    if (count === 1) return 1;
    if (count <= 3) return 2;
    if (count <= 6) return 3;
    return 4;
  }

  /* ── rendering ────────────────────────────────────────────────── */

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function heatmapHtml(counts) {
    // 53 columns of weeks, Sunday-first rows, ending on today's week.
    const today = new Date();
    const end = new Date(today);
    end.setDate(end.getDate() + (6 - end.getDay()));       // Saturday of this week
    const start = new Date(end);
    start.setDate(start.getDate() - (53 * 7 - 1));          // 53 weeks back, Sunday
    let html = '<div class="atk-heatmap-scroll"><div class="atk-heatmap">';
    // month labels row
    let labels = '<div class="atk-hm-months">';
    const cur = new Date(start);
    let lastMonth = -1;
    for (let w = 0; w < 53; w++) {
      const m = cur.getMonth();
      labels += '<span class="atk-hm-month">' + (m !== lastMonth ? MONTHS[m] : '') + '</span>';
      lastMonth = m;
      cur.setDate(cur.getDate() + 7);
    }
    labels += '</div>';
    html += labels + '<div class="atk-hm-grid">';
    const cell = new Date(start);
    const todayS = todayStr();
    for (let w = 0; w < 53; w++) {
      html += '<div class="atk-hm-col">';
      for (let r = 0; r < 7; r++) {
        const ds = localDateStr(cell);
        const future = ds > todayS;
        const c = counts[ds] || 0;
        html += '<div class="atk-hm-cell lv' + (future ? 0 : level(c)) + (future ? ' future' : '') + '" title="' +
          ds + ' — ' + c + ' ' + (c === 1 ? 'event' : 'events') + '"></div>';
        cell.setDate(cell.getDate() + 1);
      }
      html += '</div>';
    }
    html += '</div></div></div>';
    return html;
  }

  function statsHtml(counts) {
    const s = streaks(counts);
    const today = todayStr();
    const from = offsetDate(today, -(state.rangeDays - 1));
    let rangeTotal = 0, activeDays = 0;
    for (let day = from; day <= today; day = offsetDate(day, 1)) {
      if (counts[day]) { rangeTotal += counts[day]; activeDays++; }
    }
    return (
      '<div class="atk-stats">' +
        '<div class="atk-stat"><div class="n">' + s.current + '</div><div class="l">day streak</div></div>' +
        '<div class="atk-stat"><div class="n">' + s.best + '</div><div class="l">best streak</div></div>' +
        '<div class="atk-stat"><div class="n">' + rangeTotal + '</div><div class="l">events · last ' + state.rangeDays + ' days</div></div>' +
        '<div class="atk-stat"><div class="n">' + activeDays + '</div><div class="l">active days · last ' + state.rangeDays + ' days</div></div>' +
      '</div>'
    );
  }

  function categoryHtml() {
    const from = offsetDate(todayStr(), -(state.rangeDays - 1));
    const byCat = {};
    state.events.forEach(function (e) {
      if (!isWorkEvent(e) || !e.date || e.date < from || e.date > todayStr()) return;
      const c = categoryOf(e);
      byCat[c] = (byCat[c] || 0) + 1;
    });
    const rows = Object.entries(byCat).sort(function (a, b) { return b[1] - a[1]; });
    if (!rows.length) return '<div class="atk-empty">No activity in this range yet — just use RM and it shows up here.</div>';
    const max = rows[0][1];
    return '<div class="atk-cats">' + rows.map(function (kv) {
      const pct = Math.max(4, Math.round((kv[1] / max) * 100));
      return '<div class="atk-cat-row">' +
        '<div class="atk-cat-label">' + esc(prettyCategory(kv[0])) + '</div>' +
        '<div class="atk-cat-bar"><div class="atk-cat-fill" style="width:' + pct + '%"></div></div>' +
        '<div class="atk-cat-count">' + kv[1] + '</div>' +
      '</div>';
    }).join('') + '</div>';
  }

  function sourceChip(e) {
    const s = String(e.source || '').replace(/^rm-/, '');
    return '<span class="atk-chip">' + esc(s || 'event') + '</span>';
  }

  function feedHtml() {
    const from = offsetDate(todayStr(), -(state.rangeDays - 1));
    const rows = state.events
      .filter(function (e) { return isWorkEvent(e) && e.date && e.date >= from && e.date <= todayStr(); })
      .sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : 0; })
      .slice(0, 30);
    if (!rows.length) return '<div class="atk-empty">Nothing yet.</div>';
    let html = '<div class="atk-feed">';
    let lastDate = '';
    rows.forEach(function (e) {
      if (e.date !== lastDate) {
        lastDate = e.date;
        html += '<div class="atk-feed-date">' + esc(e.date) + '</div>';
      }
      html += '<div class="atk-feed-row">' + sourceChip(e) +
        '<span class="atk-feed-text">' + esc(e.text || '(no description)') + '</span></div>';
    });
    return html + '</div>';
  }

  function comingUpHtml() {
    const today = todayStr();
    const rows = state.events
      .filter(function (e) { return isScheduleMarker(e) && e.date && e.date >= today; })
      .sort(function (a, b) { return a.date > b.date ? 1 : a.date < b.date ? -1 : 0; })
      .slice(0, 15);
    if (!rows.length) return '';
    return '<div class="atk-section-title">🔭 Coming up</div><div class="atk-feed">' +
      rows.map(function (e) {
        return '<div class="atk-feed-row"><span class="atk-feed-date-inline">' + esc(e.date) + '</span>' +
          sourceChip(e) + '<span class="atk-feed-text">' + esc(e.text || '') + '</span></div>';
      }).join('') + '</div>';
  }

  function render() {
    const counts = dayCounts();
    root.innerHTML =
      statsHtml(counts) +
      heatmapHtml(counts) +
      '<div class="atk-toolbar">' +
        '<div class="atk-section-title" style="margin:0">What you did</div>' +
        '<select id="atk-range">' +
          '<option value="7"' + (state.rangeDays === 7 ? ' selected' : '') + '>Last 7 days</option>' +
          '<option value="30"' + (state.rangeDays === 30 ? ' selected' : '') + '>Last 30 days</option>' +
          '<option value="90"' + (state.rangeDays === 90 ? ' selected' : '') + '>Last 90 days</option>' +
        '</select>' +
      '</div>' +
      categoryHtml() +
      '<form id="atk-quicklog" autocomplete="off">' +
        '<input type="text" id="atk-quicklog-text" maxlength="200" placeholder="+ note what you did (optional — RM already tracks itself)">' +
      '</form>' +
      feedHtml() +
      comingUpHtml();

    const rangeSel = document.getElementById('atk-range');
    if (rangeSel) rangeSel.addEventListener('change', function () {
      state.rangeDays = parseInt(rangeSel.value, 10) || 30;
      render();
    });
    const form = document.getElementById('atk-quicklog');
    if (form) form.addEventListener('submit', async function (ev) {
      ev.preventDefault();
      const input = document.getElementById('atk-quicklog-text');
      const text = (input.value || '').trim();
      if (!text || !window.ActivitySignals) return;
      input.disabled = true;
      const written = await ActivitySignals.recordWork({
        source: 'manual',
        sourceRef: { kind: 'manual', id: Date.now().toString(36) },
        text: text,
        categoryPath: [],
      });
      input.disabled = false;
      input.value = '';
      if (written) {
        state.events.push(Object.assign({ date: todayStr() }, written));
        render();
      }
    });
  }

  /* ── styles (self-injected; legacy activity-tracker.css untouched) ── */

  function injectStyles() {
    if (document.getElementById('atk-css')) return;
    const st = document.createElement('style');
    st.id = 'atk-css';
    st.textContent =
      '.atk-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:16px}' +
      '.atk-stat{background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:14px 16px;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,.04)}' +
      '.atk-stat .n{font-size:26px;font-weight:700;color:#166534;line-height:1.1}' +
      '.atk-stat .l{font-size:11px;color:#6b7280;margin-top:4px;text-transform:uppercase;letter-spacing:.4px}' +
      '.atk-heatmap-scroll{overflow-x:auto;background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:14px;margin-bottom:16px}' +
      '.atk-heatmap{min-width:740px}' +
      '.atk-hm-months{display:flex;gap:3px;margin-bottom:4px}' +
      '.atk-hm-month{width:11px;flex:0 0 11px;font-size:9px;color:#6b7280;overflow:visible;white-space:nowrap}' +
      '.atk-hm-grid{display:flex;gap:3px}' +
      '.atk-hm-col{display:flex;flex-direction:column;gap:3px}' +
      '.atk-hm-cell{width:11px;height:11px;border-radius:2px;background:#e5e7eb}' +
      '.atk-hm-cell.future{background:transparent;border:1px dashed #f3f4f6;box-sizing:border-box}' +
      '.atk-hm-cell.lv1{background:#bbf7d0}.atk-hm-cell.lv2{background:#4ade80}' +
      '.atk-hm-cell.lv3{background:#16a34a}.atk-hm-cell.lv4{background:#14532d}' +
      '.atk-section-title{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:#475569;margin:18px 0 8px}' +
      '.atk-toolbar{display:flex;justify-content:space-between;align-items:center;margin:18px 0 8px}' +
      '.atk-toolbar select{font-size:13px;padding:5px 9px;border:1px solid #d1d5db;border-radius:6px;background:#fff}' +
      '.atk-cats{background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:12px 14px;display:grid;gap:8px}' +
      '.atk-cat-row{display:grid;grid-template-columns:170px 1fr 40px;gap:10px;align-items:center;font-size:13px}' +
      '.atk-cat-label{color:#1f2937;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
      '.atk-cat-bar{background:#f3f4f6;border-radius:4px;height:10px;overflow:hidden}' +
      '.atk-cat-fill{background:#4ade80;height:100%}' +
      '.atk-cat-count{text-align:right;color:#6b7280;font-variant-numeric:tabular-nums}' +
      '#atk-quicklog{margin:14px 0}' +
      '#atk-quicklog-text{width:100%;box-sizing:border-box;padding:9px 12px;font-size:13px;border:1px dashed #d1d5db;border-radius:8px;background:#fafafa}' +
      '#atk-quicklog-text:focus{background:#fff;border-style:solid;outline:none}' +
      '.atk-feed{background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:8px 14px;margin-bottom:14px}' +
      '.atk-feed-date{font-size:11px;font-weight:700;color:#6b7280;margin:8px 0 4px}' +
      '.atk-feed-date-inline{font-size:11px;color:#6b7280;font-variant-numeric:tabular-nums;margin-right:8px}' +
      '.atk-feed-row{display:flex;align-items:baseline;gap:8px;padding:3px 0;font-size:13px;color:#1f2937}' +
      '.atk-feed-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '.atk-chip{flex:0 0 auto;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;background:#eff6ff;color:#1e40af;border-radius:8px;padding:2px 7px}' +
      '.atk-empty{padding:16px;text-align:center;color:#9ca3af;font-size:13px;background:#fff;border:1px dashed #e5e7eb;border-radius:10px}';
    document.head.appendChild(st);
  }

  /* ── boot ─────────────────────────────────────────────────────── */

  async function init() {
    injectStyles();
    root.innerHTML = '<div class="atk-empty">Loading…</div>';
    if (typeof firebridge === 'undefined' || !firebridge.whenAuthResolved) {
      root.innerHTML = '<div class="atk-empty">Sign-in unavailable.</div>';
      return;
    }
    const auth = await firebridge.whenAuthResolved();
    if (!auth.user) {
      root.innerHTML = '<div class="atk-empty">Sign in via the avatar in the top nav to see your activity.</div>';
      return;
    }
    state.me = auth.user;
    if (!window.ActivitySignals) {
      root.innerHTML = '<div class="atk-empty">activity-signals.js not loaded.</div>';
      return;
    }
    const from = offsetDate(todayStr(), -371);
    state.events = await ActivitySignals.listEvents(state.me.uid, { from: from });
    render();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
