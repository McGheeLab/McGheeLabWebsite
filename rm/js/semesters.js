/* semesters.js — V3.715 (Semester Focus layer)
 *
 * The lab's canonical semester calendar: admin-set date ranges stored in
 * ONE doc at labConfig/semesters (route: settings/semesters.json — auth
 * read, admin write under the existing labConfig rule). Team Focus and
 * My Week resolve "which semester is this?" through here.
 *
 *   { semesters: [ { id: 'sem-2026-fall', label: 'Fall 2026',
 *                    start: 'YYYY-MM-DD', end: 'YYYY-MM-DD' } ],
 *     updated_at, updated_by }
 *
 * When no configured semester covers a date, currentOrFallback() computes
 * a UA-shaped term (same math as pmr.js periods — Aug–Dec fall, Jun–Jul
 * summer, else spring) flagged `computed: true`, so the pages keep working
 * before an admin has seeded real dates. Weekly-focus attribution hangs
 * off the semester-FOCUS doc id, not the semester id, so a focus created
 * under a computed semester survives the admin later configuring one.
 *
 * NOTE: meetings.js keeps its own single semesterStart/End (meeting
 * calendar generation) and pmr.js its own computed periods — this doc is
 * the canonical multi-semester list; migrating those two is a follow-up.
 *
 * Globals: window.SEMESTERS
 */
(function () {
  'use strict';

  var ROUTE = 'settings/semesters.json';
  var _list = null;   // sorted by start asc; null until load()

  function me() {
    var u = window.firebridge && firebridge.getUser ? firebridge.getUser() : null;
    return u ? u.uid : null;
  }

  function sortByStart(rows) {
    return rows.slice().sort(function (a, b) { return (a.start || '').localeCompare(b.start || ''); });
  }

  async function load() {
    if (_list) return _list;
    try {
      var doc = await api.load(ROUTE);
      _list = sortByStart((doc && Array.isArray(doc.semesters)) ? doc.semesters : []);
    } catch (e) {
      console.warn('[semesters] load failed:', e && e.message);
      _list = [];
    }
    return _list;
  }

  function list() { return _list || []; }

  /** Admin write — caller gates on firebridge.isAdmin(). */
  async function save(semesters) {
    var rows = sortByStart((semesters || []).filter(function (s) {
      return s && s.label && s.start && s.end;
    }).map(function (s) {
      return { id: s.id || idFor(s.label), label: String(s.label).slice(0, 60), start: s.start, end: s.end };
    }));
    await api.save(ROUTE, { semesters: rows, updated_at: new Date().toISOString(), updated_by: me() });
    _list = rows;
    return rows;
  }

  function idFor(label) {
    return 'sem-' + String(label).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }

  function localToday() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  /** The configured semester covering a YYYY-MM-DD (or today), else null. */
  function semesterFor(dateStr) {
    var d = dateStr || localToday();
    return list().find(function (s) { return s.start <= d && d <= s.end; }) || null;
  }

  /* ── computed fallback (pmr.js period math) ───────────────── */

  function termFromDate(dateStr) {
    var m = +(dateStr || localToday()).split('-')[1];
    var y = +(dateStr || localToday()).split('-')[0];
    if (m >= 8) return { year: y, term: 'fall' };
    if (m >= 6) return { year: y, term: 'summer' };
    return { year: y, term: 'spring' };
  }
  function termDates(year, term) {
    if (term === 'fall')   return { start: year + '-08-25', end: year + '-12-15' };
    if (term === 'spring') return { start: year + '-01-10', end: year + '-05-15' };
    return { start: year + '-06-01', end: year + '-08-15' };   // summer
  }
  function computedSemester(year, term) {
    var dates = termDates(year, term);
    var label = term[0].toUpperCase() + term.slice(1) + ' ' + year;
    return { id: 'sem-' + year + '-' + term, label: label, start: dates.start, end: dates.end, computed: true };
  }

  /** The semester a date falls in: configured if one covers it, else a
   * computed term so the page always has a working period. */
  function currentOrFallback(dateStr) {
    var hit = semesterFor(dateStr);
    if (hit) return hit;
    var t = termFromDate(dateStr || localToday());
    return computedSemester(t.year, t.term);
  }

  /* Step a term one semester forward/back: spring → summer → fall → next
   * spring. Used when nav walks off the configured list. */
  function stepTerm(year, term, dir) {
    var seq = ['spring', 'summer', 'fall'];
    var i = seq.indexOf(term) + dir;
    if (i < 0) return { year: year - 1, term: 'fall' };
    if (i > 2) return { year: year + 1, term: 'spring' };
    return { year: year, term: seq[i] };
  }

  /** The previous (dir=-1) or next (dir=+1) semester. Configured
   * neighbors win; past the ends of the configured list we degrade to
   * computed terms — preferring a configured semester whose range
   * overlaps the computed one, so nav re-enters the list cleanly. */
  function neighbor(sem, dir) {
    var rows = list();
    var idx = rows.findIndex(function (s) { return s.id === sem.id; });
    if (idx >= 0 && rows[idx + dir]) return rows[idx + dir];
    var t = termFromDate(sem.start);
    var next = stepTerm(t.year, t.term, dir);
    var comp = computedSemester(next.year, next.term);
    var hit = rows.find(function (s) { return s.start <= comp.end && comp.start <= s.end; });
    return hit || comp;
  }

  /** The ISO-week span a semester covers (weekly-focus range queries). */
  function weekRange(sem) {
    return {
      fromWeekId: FOCUS_AREAS.weekIdFor(sem.start),
      toWeekId: FOCUS_AREAS.weekIdFor(sem.end),
    };
  }

  window.SEMESTERS = {
    load: load,
    list: list,
    save: save,
    idFor: idFor,
    semesterFor: semesterFor,
    currentOrFallback: currentOrFallback,
    neighbor: neighbor,
    weekRange: weekRange,
  };
})();
