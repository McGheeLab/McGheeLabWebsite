/* project-health.js — V3.625 (My Week outcomes → PMR health program, R3)
 *
 * Pure compute for per-project health from the My Week outcome ledger
 * (V3.623). No DOM — pmr.js gathers the raw rows and renders; this module
 * decides which projects a student has, attributes ledger items to them,
 * and scores each project week by week.
 *
 * The "project" unit is a researchFoci card — normally an OUTPUT card
 * ("the paragraphs we ship") the student is attached to via member_uids
 * or a roadmap analysis owner_uids, plus any card the student's weekly
 * focusAreas explicitly aligned to (focus_ref) inside the window.
 *
 * Attribution chain (all denormalized ids, no extra reads):
 *   dayPlan.details.focusId → focusAreas/{id}.focus_ref.id → researchFoci
 * Items with no focus link stay in the ledger but never touch health.
 *
 * Scoring model (all tunables in CONFIG — expect to retune after 2-3
 * weeks of real data):
 *   - Unaccepted BARRIER chains escalate: −W_BARRIER × chain length per
 *     week, where the chain is consecutive weeks each containing ≥1
 *     unaccepted barrier on the project. A mentor acceptance
 *     (healthReviews doc naming the barrier item) neutralizes that item;
 *     a week whose barriers are all accepted breaks the chain.
 *   - NO-RESULT streaks: weeks whose recorded outcomes are all ◌ (and at
 *     least one) cost −W_NO_RESULT × streak length.
 *   - OVERDUE outcomes: a past week containing items with no outcome at
 *     all costs −W_OVERDUE (total capped at OVERDUE_CAP).
 *   - SILENCE: for projects the student OWNS (member/analysis owner),
 *     weeks with no attributed items AND no aligned focus area count
 *     −W_SILENCE each after SILENCE_GRACE consecutive quiet weeks
 *     (total capped at SILENCE_CAP).
 *   - RESULTS recover: a week with ≥1 ✅ earns +W_RESULT (total capped
 *     at RESULT_CAP).
 * Health = Σ weekScore over the last SCORE_WEEKS; buckets on HEALTHY_MIN
 * / ATTENTION_MIN. Trend compares the last TREND_WEEKS against the
 * TREND_WEEKS before them.
 *
 * Globals: window.PROJECT_HEALTH
 * Depends: firebridge; window.RESEARCH_DATA + window.ROADMAP_DATA for the
 * project list (both lab-readable); FOCUS_AREAS.weekIdFor for week keys.
 */
(function () {
  'use strict';

  var CONFIG = {
    WINDOW_WEEKS: 8,     // weeks of history considered (strip length)
    SCORE_WEEKS: 4,      // health = sum of the most recent N week scores
    TREND_WEEKS: 2,      // trend = last N vs the N before
    W_BARRIER: 1.0,
    W_NO_RESULT: 0.5,
    W_OVERDUE: 0.5, OVERDUE_CAP: 2,
    W_SILENCE: 1.0, SILENCE_GRACE: 1, SILENCE_CAP: 3,
    W_RESULT: 1.0, RESULT_CAP: 2,
    HEALTHY_MIN: -1,     // health ≥ this → healthy
    ATTENTION_MIN: -3,   // health ≥ this (and < HEALTHY_MIN) → attention; below → stuck
  };

  var STATUS_META = {
    healthy:   { label: 'Healthy',         color: '#16a34a' },
    attention: { label: 'Needs attention', color: '#f59e0b' },
    stuck:     { label: 'Stuck',           color: '#dc2626' },
  };
  var TREND_META = {
    up:   { icon: '↗', label: 'improving' },
    flat: { icon: '→', label: 'steady' },
    down: { icon: '↘', label: 'declining' },
  };

  /* ── date plumbing (local math, mirrors my-week.js) ─────────── */

  function todayStr() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function shiftDate(dateStr, days) {
    var p = dateStr.split('-');
    var d = new Date(+p[0], +p[1] - 1, +p[2]);
    d.setDate(d.getDate() + days);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function mondayOf(dateStr) {
    var p = dateStr.split('-');
    var dow = new Date(+p[0], +p[1] - 1, +p[2]).getDay();
    return shiftDate(dateStr, dow === 0 ? -6 : 1 - dow);
  }

  /** Ascending Monday strings for the scoring window, ending at the
   * current week. */
  function windowMondays(weeks) {
    var n = weeks || CONFIG.WINDOW_WEEKS;
    var cur = mondayOf(todayStr());
    var out = [];
    for (var i = n - 1; i >= 0; i--) out.push(shiftDate(cur, -7 * i));
    return out;
  }

  /* ── project discovery ─────────────────────────────────────── */

  var _fociCache = null;
  async function listAllFoci() {
    if (_fociCache) return _fociCache;
    if (!window.RESEARCH_DATA) return [];
    _fociCache = await RESEARCH_DATA.listAll();
    return _fociCache || [];
  }

  /** Does this card's roadmap attach the student at the experiment or
   * analysis level? */
  function roadmapOwns(card, uid) {
    if (!window.ROADMAP_DATA || !card.roadmap) return false;
    try {
      var rows = ROADMAP_DATA.flattenAnalyses(card.roadmap);
      for (var i = 0; i < rows.length; i++) {
        var a = rows[i].analysis || {};
        if ((a.owner_uids || []).indexOf(uid) >= 0) return true;
      }
      var exps = (card.roadmap.experiments || []);
      for (var j = 0; j < exps.length; j++) {
        if (((exps[j] || {}).owner_uids || []).indexOf(uid) >= 0) return true;
      }
    } catch (e) { /* hydration quirks never break health */ }
    return false;
  }

  /** The student's projects: OUTPUT cards they're attached to (member or
   * roadmap owner) ∪ any card their windowed focusAreas aligned to.
   * `owned` marks cards where silence counts against health — an explicit
   * attachment, not merely a historical focus_ref. */
  async function listProjectsForStudent(uid, focusAreas) {
    var all = await listAllFoci();
    var refIds = {};
    (focusAreas || []).forEach(function (f) {
      if (f.focus_ref && f.focus_ref.id) refIds[f.focus_ref.id] = true;
    });
    var rows = [];
    all.forEach(function (card) {
      if (!card || card.status === 'archived' || card.status === 'closed') return;
      var member = (card.member_uids || []).indexOf(uid) >= 0;
      var roadmap = roadmapOwns(card, uid);
      // V3.717 — an owned "project" is anything that ships or must deliver:
      // an aim, the output synthesizing it, or the grant they sit under. A
      // specialty is a capability and a concept is an idea; neither goes
      // quiet in a way worth flagging, which is what `owned` gates.
      var ownable = card.level === 'output' || card.level === 'aim' || card.level === 'grant';
      var owned = ownable && (member || roadmap);
      var referenced = !!refIds[card.id];
      if (!owned && !referenced) return;
      rows.push({
        id: card.id,
        title: card.title || card.id,
        icon: card.icon || '',
        level: card.level || 'concept',
        status: card.status || '',
        owned: owned,
      });
    });
    return rows;
  }

  /* ── attribution + scoring ─────────────────────────────────── */

  /** focusAreaId → foci id, from the windowed focusAreas. */
  function focusToProjectMap(focusAreas) {
    var map = {};
    (focusAreas || []).forEach(function (f) {
      if (f.id && f.focus_ref && f.focus_ref.id) map[f.id] = f.focus_ref.id;
    });
    return map;
  }

  function itemProject(item, faMap) {
    var det = item.details || {};
    return (det.focusId && faMap[det.focusId]) || null;
  }

  /**
   * Score every project over the window.
   * @param opts {
   *   projects:   rows from listProjectsForStudent,
   *   items:      dayPlan docs covering the window (any superset is fine),
   *   focusAreas: focusAreas docs covering the window,
   *   reviews:    healthReviews docs (all of them — they're small),
   *   weekIdFor:  FOCUS_AREAS.weekIdFor (injected to avoid a hard dep),
   * }
   * @returns [{ id, title, icon, level, owned, health, status, trend,
   *             why, weeks: [{monday, icon, score, ...counts}],
   *             barrierRows: [{item, monday, accepted, review}] }]
   */
  function compute(opts) {
    var projects = opts.projects || [];
    var items = opts.items || [];
    var focusAreas = opts.focusAreas || [];
    var reviews = opts.reviews || [];
    var weekIdFor = opts.weekIdFor || (window.FOCUS_AREAS && FOCUS_AREAS.weekIdFor) || function () { return ''; };

    var mondays = windowMondays(opts.windowWeeks);
    var curMonday = mondays[mondays.length - 1];
    var faMap = focusToProjectMap(focusAreas);
    var acceptedByItem = {};
    reviews.forEach(function (r) { if (r && r.item_id) acceptedByItem[r.item_id] = r; });

    // week monday → ISO weekId, for matching focusAreas to weeks
    var weekIdOfMonday = {};
    mondays.forEach(function (m) { weekIdOfMonday[m] = weekIdFor(m); });

    // bucket items + focus areas by (project, monday)
    var byProjWeek = {};   // pid → monday → {items:[], fas:[]}
    function bucket(pid, mon) {
      var p = byProjWeek[pid] = byProjWeek[pid] || {};
      return (p[mon] = p[mon] || { items: [], fas: [] });
    }
    items.forEach(function (it) {
      if (!it || !it.date) return;
      var pid = itemProject(it, faMap);
      if (!pid) return;
      var mon = mondayOf(it.date);
      if (mon < mondays[0] || mon > curMonday) return;
      bucket(pid, mon).items.push(it);
    });
    focusAreas.forEach(function (f) {
      if (!f || !f.focus_ref || !f.focus_ref.id || !f.weekId) return;
      mondays.forEach(function (m) {
        if (weekIdOfMonday[m] === f.weekId) bucket(f.focus_ref.id, m).fas.push(f);
      });
    });

    var today = todayStr();

    return projects.map(function (proj) {
      var chain = 0, noResStreak = 0, silent = 0;
      var overdueSpent = 0, resultSpent = 0;
      var weeks = [];
      var barrierRows = [];

      mondays.forEach(function (mon) {
        var slot = (byProjWeek[proj.id] || {})[mon] || { items: [], fas: [] };
        var pastWeek = mon < mondayOf(today);   // fully elapsed weeks judge silence/overdue
        var score = 0;
        var counts = { result: 0, barrier: 0, unaccepted: 0, no_result: 0, overdue: 0 };

        slot.items.forEach(function (it) {
          var k = it.outcome && it.outcome.kind;
          if (k === 'result') counts.result++;
          else if (k === 'barrier') {
            counts.barrier++;
            var review = acceptedByItem[it.id] || null;
            if (!review) counts.unaccepted++;
            barrierRows.push({ item: it, monday: mon, accepted: !!review, review: review });
          }
          else if (k === 'no_result') counts.no_result++;
          else if (it.date < today && (it.status === 'done' || it.status === 'skipped' || it.status === 'planned')) counts.overdue++;
        });

        // barrier chain — escalates while unaccepted barriers persist;
        // a week whose barriers are all accepted (or barrier-free) breaks it
        if (counts.unaccepted > 0) {
          chain++;
          score -= CONFIG.W_BARRIER * chain;
        } else {
          chain = 0;
        }

        // no-result streak — recorded outcomes exist but they're all ◌
        var recorded = counts.result + counts.barrier + counts.no_result;
        if (recorded > 0 && counts.no_result === recorded) {
          noResStreak++;
          score -= CONFIG.W_NO_RESULT * noResStreak;
        } else if (recorded > 0) {
          noResStreak = 0;
        }

        // overdue — any past-week item with no verdict at all
        if (pastWeek && counts.overdue > 0 && overdueSpent < CONFIG.OVERDUE_CAP) {
          score -= CONFIG.W_OVERDUE;
          overdueSpent += CONFIG.W_OVERDUE;
        }

        // silence — owned projects with no plans and no aligned focus
        var active = slot.items.length > 0 || slot.fas.length > 0;
        if (proj.owned && pastWeek && !active) {
          silent++;
          if (silent > CONFIG.SILENCE_GRACE && (silent - CONFIG.SILENCE_GRACE) * CONFIG.W_SILENCE <= CONFIG.SILENCE_CAP) {
            score -= CONFIG.W_SILENCE;
          }
        } else if (active) {
          silent = 0;
        }

        // results recover
        if (counts.result > 0 && resultSpent < CONFIG.RESULT_CAP) {
          score += CONFIG.W_RESULT;
          resultSpent += CONFIG.W_RESULT;
        }

        var icon = counts.unaccepted ? 'construction'
          : counts.result ? 'check-circle'
          : counts.barrier ? 'construction'
          : counts.no_result ? '◌'
          : counts.overdue ? '◇'
          : active ? '·' : '';
        weeks.push({ monday: mon, score: score, icon: icon, active: active, counts: counts, silent: proj.owned && pastWeek && !active });
      });

      var scoreWeeks = weeks.slice(-CONFIG.SCORE_WEEKS);
      var health = scoreWeeks.reduce(function (s, w) { return s + w.score; }, 0);
      var status = health >= CONFIG.HEALTHY_MIN ? 'healthy'
        : health >= CONFIG.ATTENTION_MIN ? 'attention' : 'stuck';

      var t = CONFIG.TREND_WEEKS;
      var recent = weeks.slice(-t).reduce(function (s, w) { return s + w.score; }, 0);
      var prior = weeks.slice(-2 * t, -t).reduce(function (s, w) { return s + w.score; }, 0);
      var trend = (recent - prior) > 0.5 ? 'up' : (recent - prior) < -0.5 ? 'down' : 'flat';

      // the "why" line — dominant factor, phrased for a human. The live
      // chain is read off the window's TAIL: consecutive most-recent weeks
      // still carrying an unaccepted barrier.
      var tailChain = 0;
      for (var i = weeks.length - 1; i >= 0 && weeks[i].counts.unaccepted > 0; i--) tailChain++;
      var lastOpen = barrierRows.filter(function (r) { return !r.accepted; }).pop();
      var chainSummary = (lastOpen && lastOpen.item.outcome && lastOpen.item.outcome.summary) || '';
      // Silence tail: the current (unfinished) week can't be judged, so it
      // neither counts nor breaks the run — unless it's already active.
      var silentTail = 0;
      var curWeek = weeks[weeks.length - 1];
      if (!(curWeek && curWeek.active)) {
        for (var j = weeks.length - 2; j >= 0 && weeks[j].silent; j--) silentTail++;
      }
      var overdueCount = weeks.reduce(function (s, w) { return s + w.counts.overdue; }, 0);
      var resultCount = scoreWeeks.reduce(function (s, w) { return s + w.counts.result; }, 0);
      var why;
      if (tailChain > 1) {
        why = 'barrier ' + tailChain + ' weeks unaccepted' + (chainSummary ? ': “' + chainSummary + '”' : '');
      } else if (tailChain === 1) {
        why = 'new barrier' + (chainSummary ? ': “' + chainSummary + '”' : '');
      } else if (silentTail > CONFIG.SILENCE_GRACE) {
        why = 'no activity for ' + silentTail + ' weeks';
      } else if (overdueCount > 0) {
        why = overdueCount + ' step' + (overdueCount === 1 ? '' : 's') + ' missing outcomes';
      } else if (noResStreak > 1) {
        why = noResStreak + ' weeks without a result';
      } else if (resultCount > 0) {
        why = resultCount + ' result' + (resultCount === 1 ? '' : 's') + ' in the last ' + CONFIG.SCORE_WEEKS + ' weeks';
      } else {
        why = 'quiet — nothing recorded recently';
      }

      return {
        id: proj.id, title: proj.title, icon: proj.icon, level: proj.level, owned: proj.owned,
        health: Math.round(health * 10) / 10,
        status: status, trend: trend, why: why,
        weeks: weeks,
        barrierRows: barrierRows.sort(function (a, b) { return (a.monday || '').localeCompare(b.monday || ''); }),
      };
    }).sort(function (a, b) {
      var rank = { stuck: 0, attention: 1, healthy: 2 };
      return (rank[a.status] - rank[b.status]) || a.title.localeCompare(b.title);
    });
  }

  window.PROJECT_HEALTH = {
    CONFIG: CONFIG,
    STATUS_META: STATUS_META,
    TREND_META: TREND_META,
    windowMondays: windowMondays,
    listProjectsForStudent: listProjectsForStudent,
    compute: compute,
    _resetFociCache: function () { _fociCache = null; },
  };
})();
