/* library-recent.js — V3.825: filter papers by how recently they were added,
 * and a persistent "Recently added" section at the top of the library.
 *
 * Alex: "in the library, i want to be able to filter papers by how recent we
 * added them. also keep a persistent section that says recently downloaded
 * papers".
 *
 * When was a paper added? `meta.library.captured_at_iso` (extension captures,
 * to the second), else `meta.library.date_added` (every item built by
 * LIBRARY_METADATA.buildPaperItem stamps the day), else the PDF's
 * `uploaded_at`. A paper with none of these is "unknown": it never matches a
 * recency window and counts as older than everything.
 *
 * Two surfaces, one core:
 *   - the toolbar select (#library-added) and the `added:` query token
 *     (added:today, added:7d, added:30d, added:90d, added:year, added:2026,
 *     added:2026-10, added:older) — the token is what a saved smart group
 *     keeps, the select is a per-browser convenience (localStorage);
 *   - the 🆕 Recently added SHELF (V3.826: inside the Shelves block, rendered
 *     by library-groups.js, folded by default like every shelf): the newest
 *     papers newest-first, "show more", and a "see all from the last 30
 *     days" link that sets the filter. library.js hands the visible pool to
 *     setPool() on every render; the shelf fills #lib-recent via render().
 *
 * The core (LIBRARY_RECENT_CORE) is DOM-free and node-testable; the page half
 * (LIBRARY_RECENT) renders into the library page and talks to library.js. */
(function (root) {
  'use strict';

  const DAY = 86400000;

  function addedMs(item) {
    const lib = (item && item.meta && item.meta.library) || {};
    const cands = [lib.captured_at_iso, lib.date_added, lib.pdf && lib.pdf.uploaded_at];
    for (const c of cands) {
      if (!c) continue;
      const t = Date.parse(String(c));
      if (!isNaN(t) && t > 0) return t;
    }
    return 0;
  }

  /** 'today' | '7d' | '30d' | '90d' | '365d' | 'year' | '2026' | '2026-10' | 'older' | '' → spec or null. */
  function parseWindow(value) {
    const v = String(value || '').trim().toLowerCase();
    if (!v || v === 'any' || v === 'all') return null;
    if (v === 'today') return { kind: 'days', n: 1 };
    let m = v.match(/^(\d{1,4})\s*d(?:ays?)?$/); if (m) return { kind: 'days', n: Math.max(1, parseInt(m[1], 10)) };
    m = v.match(/^(\d{1,3})\s*w(?:eeks?)?$/); if (m) return { kind: 'days', n: 7 * Math.max(1, parseInt(m[1], 10)) };
    m = v.match(/^(\d{1,3})\s*m(?:onths?)?$/); if (m) return { kind: 'days', n: 30 * Math.max(1, parseInt(m[1], 10)) };
    if (v === 'year' || v === 'thisyear' || v === 'this-year') return { kind: 'year', y: 0 };
    m = v.match(/^(\d{4})-(\d{1,2})$/); if (m) return { kind: 'month', y: parseInt(m[1], 10), m: parseInt(m[2], 10) };
    m = v.match(/^(\d{4})$/); if (m) return { kind: 'year', y: parseInt(m[1], 10) };
    m = v.match(/^older(?:-?than)?-?(\d{1,4})?d?$/); if (m) return { kind: 'older', n: m[1] ? parseInt(m[1], 10) : 90 };
    return null;
  }

  function withinWindow(item, spec, nowMs) {
    if (!spec) return true;
    const t = addedMs(item);
    const now = typeof nowMs === 'number' ? nowMs : Date.now();
    if (spec.kind === 'older') return !t || t < now - spec.n * DAY;
    if (!t) return false;
    if (spec.kind === 'days') return t >= now - spec.n * DAY && t <= now + DAY;
    const d = new Date(t), nd = new Date(now);
    if (spec.kind === 'year') return d.getFullYear() === (spec.y || nd.getFullYear());
    if (spec.kind === 'month') return d.getFullYear() === spec.y && d.getMonth() + 1 === spec.m;
    return true;
  }

  function recentList(items, opts) {
    const limit = (opts && opts.limit) || 8;
    return (items || [])
      .map((it) => ({ it, t: addedMs(it) }))
      .filter((x) => x.t > 0)
      .sort((a, b) => b.t - a.t || String(a.it.title || '').localeCompare(String(b.it.title || '')))
      .slice(0, limit)
      .map((x) => x.it);
  }

  function countWithin(items, days, nowMs) {
    const spec = { kind: 'days', n: days };
    return (items || []).filter((it) => withinWindow(it, spec, nowMs)).length;
  }

  function relTime(ms, nowMs) {
    if (!ms) return '';
    const now = typeof nowMs === 'number' ? nowMs : Date.now();
    const days = Math.floor((now - ms) / DAY);
    if (days <= 0) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 14) return days + ' days ago';
    if (days < 60) return Math.round(days / 7) + ' weeks ago';
    if (days < 365) return Math.round(days / 30) + ' months ago';
    const y = Math.floor(days / 365); return y + (y === 1 ? ' year ago' : ' years ago');
  }

  const WINDOW_LABEL = { '': 'Added: any time', today: 'Added today', '7d': 'Added: last 7 days', '30d': 'Added: last 30 days', '90d': 'Added: last 90 days', year: 'Added: this year', older: 'Added: more than 90 days ago' };

  const CORE = { addedMs, parseWindow, withinWindow, recentList, countWithin, relTime, WINDOW_LABEL, DAY };

  if (typeof module !== 'undefined' && module.exports) module.exports = CORE;
  if (!root || typeof root.document === 'undefined') return;
  root.LIBRARY_RECENT_CORE = CORE;

  /* ── page half ─────────────────────────────────────────────────────── */
  const STORE_KEY = 'lib_added_filter';
  const LIMIT = 8, LIMIT_MORE = 24;
  let _value = '';          // the select's value ('' = any time)
  let _limit = LIMIT;
  let _onChange = null;
  let _pool = [];           // the papers the person may see (library.js setPool)

  function _esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function _load() { try { return localStorage.getItem(STORE_KEY) || ''; } catch (_) { return ''; } }
  function _persist(v) { try { if (v) localStorage.setItem(STORE_KEY, v); else localStorage.removeItem(STORE_KEY); } catch (_) {} }

  function active() { return !!parseWindow(_value); }
  function spec() { return parseWindow(_value); }
  function matches(item) { return withinWindow(item, spec(), Date.now()); }
  function value() { return _value; }
  function label() { return WINDOW_LABEL[_value] || ('Added: ' + _value); }

  function setFilter(v, opts) {
    _value = String(v || '');
    _persist(_value);
    const sel = document.getElementById('library-added');
    if (sel && sel.value !== _value) { if (![...sel.options].some((o) => o.value === _value)) { const o = document.createElement('option'); o.value = _value; o.textContent = label(); sel.appendChild(o); } sel.value = _value; }
    if (!(opts && opts.silent) && typeof _onChange === 'function') _onChange();
  }

  function init(opts) {
    _onChange = opts && opts.onChange;
    const sel = document.getElementById('library-added');
    const stored = _load();
    if (stored && parseWindow(stored)) setFilter(stored, { silent: true });
    if (sel) sel.addEventListener('change', () => setFilter(sel.value));
    document.addEventListener('click', (e) => {
      const more = e.target.closest('[data-recent-more]');
      if (more) { e.preventDefault(); _limit = _limit === LIMIT ? LIMIT_MORE : LIMIT; render(); return; }
      const all = e.target.closest('[data-recent-filter]');
      if (all) { e.preventDefault(); setFilter(all.dataset.recentFilter); const t = document.querySelector('.lib-table'); if (t && t.scrollIntoView) t.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    });
  }

  function _row(it, now) {
    const lib = it.meta.library || {};
    const t = addedMs(it);
    const journalYear = [lib.journal, lib.year].filter(Boolean).join(' · ');
    const authors = (lib.authors || []).slice(0, 2).map((a) => (a.family || a.name || '')).filter(Boolean).join(', ') + ((lib.authors || []).length > 2 ? ' et al.' : '');
    const by = lib.captured_by || (lib.pdf && lib.pdf.uploaded_by) || '';
    const href = '/rm/pages/library-paper.html?id=' + encodeURIComponent(it.id);
    const hasPdf = !!(lib.pdf && lib.pdf.storage_path);
    return '<div class="lrc-row">' +
      '<div class="lrc-main">' +
        '<a class="lrc-title" href="' + _esc(href) + '">' + _esc(it.title || 'Untitled') + '</a>' +
        '<div class="lrc-meta">' + (authors ? '<span>' + _esc(authors) + '</span>' : '') + (journalYear ? '<span>' + _esc(journalYear) + '</span>' : '') +
          '<span class="lrc-when" title="' + _esc(t ? new Date(t).toLocaleString() : '') + '">added ' + _esc(relTime(t, now)) + (by ? ' · ' + _esc(String(by).split('@')[0]) : '') + (lib.captured_via === 'pdf-tab' || lib.captured_via === 'extension' || lib.captured_by ? ' · extension' : '') + '</span>' +
        '</div>' +
      '</div>' +
      '<div class="lrc-actions">' + (hasPdf ? '<a class="btn btn-sm" href="' + _esc(href) + '">Read</a>' : '<span class="lrc-nopdf" title="No PDF attached yet">no PDF</span>') + '</div>' +
    '</div>';
  }

  /** library.js: the papers the person may see, on every render (the shelf reads it). */
  function setPool(papers) { _pool = papers || []; }
  function hasAny() { return recentList(_pool, { limit: 1 }).length > 0; }
  function count30() { return countWithin(_pool, 30, Date.now()); }
  function countLabel() { const n = count30(); return n ? n + ' in 30 days' : ''; }

  /** Fill #lib-recent (the shelf body) from the pool; `papers` overrides the pool (tests). */
  function render(papers) {
    if (Array.isArray(papers)) _pool = papers;
    const host = document.getElementById('lib-recent');
    if (!host) return;
    const now = Date.now();
    const list = recentList(_pool, { limit: _limit });
    const total = recentList(_pool, { limit: 1e9 }).length;
    const n30 = countWithin(_pool, 30, now);
    if (!list.length) { host.innerHTML = '<span class="lg-empty">Nothing dated yet.</span>'; return; }
    host.innerHTML = '<div class="lrc-list">' + list.map((it) => _row(it, now)).join('') + '</div>' +
      '<div class="lrc-foot">' +
        (total > LIMIT ? '<a href="#" data-recent-more>' + (_limit === LIMIT ? 'Show ' + Math.min(LIMIT_MORE, total) + ' ↓' : 'Show fewer ↑') + '</a>' : '') +
        '<a href="#" data-recent-filter="30d">See all added in the last 30 days (' + n30 + ') ↓</a>' +
        (active() ? '<span class="lrc-active">Filter on: ' + _esc(label()) + ' — <a href="#" data-recent-filter="">clear</a></span>' : '') +
      '</div>';
  }

  root.LIBRARY_RECENT = { init, render, setPool, hasAny, count30, countLabel, active, spec, matches, value, label, setFilter, core: CORE };
})(typeof window !== 'undefined' ? window : null);
