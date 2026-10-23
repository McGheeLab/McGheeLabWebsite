/* research-grant-review.js — V3.717 (Grants become a level)
 *
 * The body of a grant's page on rm/pages/research.html?id=<grantId>. A
 * grant is the unit the lab's work is actually spent against, so its page
 * answers "what is happening under this grant?" — not "what is this card?".
 *
 * Four sections, in the order a PI reads them:
 *   Aims     — the target results the grant needs, each with its roadmap
 *              progress and the outputs synthesizing it.
 *   Outputs  — the papers and patents under it.
 *   Drafts   — every linked builder draft across the grant and its
 *              descendants, deduped, status resolved live.
 *   People   — who is spending time on it, from their own semester and
 *              weekly foci.
 *   Refs     — LAST and COLLAPSED, deliberately: the bibliography is material
 *              to go and look something up in, not a status anyone scans the
 *              page for, and 100+ entries expanded would bury the aims and
 *              the people this page exists to show.
 *
 * ATTRIBUTION IS DERIVED, NEVER STORED. A focusArea points at a card
 * (`focus_ref.id`); RESEARCH_DATA.grantIdsForCard walks that card up the
 * chain to its grant. Nothing is denormalized onto a focusArea, so
 * re-parenting an aim retroactively re-attributes every past week.
 *
 * VISIBILITY IS THE EXISTING RULES, NOT A NEW SURFACE — the same contract
 * research-progress.js works under. focusAreas are readable by owner ∥
 * mentor ∥ admin, so each member's read is attempted independently and a
 * denied one degrades to a quiet "not visible to you" row. The PI sees the
 * whole roster; a student sees their own slice. No collectionGroup query,
 * no rules change, no index.
 *
 * Globals: window.GRANT_REVIEW.
 */
(function () {
  'use strict';

  var RD = window.RESEARCH_DATA;
  var esc = RD.esc;
  var WEEKS_BACK = 52;      // a grant's life is measured in years, not weeks
  var WEEKS_AHEAD = 4;      // planned-but-not-yet-arrived weeks still count

  function fociUrl(id) { return '/rm/pages/research.html?id=' + encodeURIComponent(id); }

  /* ── roster ─────────────────────────────────────────────────── */

  /* V3.722 — `member_roles[uid] === 'secondary'` marks a tangential role;
   * anyone else in `member_uids` is primary. Deliberately tolerant of the
   * pre-V3.722 free-text roles ('lead', 'contributor', …): only the exact
   * string 'secondary' demotes, so nothing already typed silently changes
   * meaning. */
  function isSecondary(grant, uid) {
    return ((grant.member_roles || {})[uid] || '') === 'secondary';
  }
  function assignedPeople(grant) {
    var uids = (grant.member_uids || []).slice();
    return {
      primary: uids.filter(function (u) { return !isSecondary(grant, u); }),
      secondary: uids.filter(function (u) { return isSecondary(grant, u); }),
    };
  }

  /* Who to READ. Assigned people always; plus, for someone who can see other
   * people's foci, the mentee roster — scanned to FIND unassigned
   * contributors. Scanning is not the same as listing: a scanned uid with no
   * work under this grant is never rendered (V3.722 — the section used to
   * print the whole lab, one "no focus aligned yet" row per person, which
   * told the PI nothing and buried the people who were actually on it). */
  async function roster(grant, cards, pageState) {
    var assigned = assignedPeople(grant);
    var read = assigned.primary.concat(assigned.secondary);
    function add(u) { if (u && read.indexOf(u) === -1) read.push(u); }
    // Members of the aims/outputs beneath count as assigned-adjacent: they
    // were put on the work deliberately, just at a finer grain.
    cards.forEach(function (c) { if (c.id !== grant.id) (c.member_uids || []).forEach(add); });

    var me = pageState.me ? pageState.me.uid : null;
    var privileged = pageState.isAdmin ||
      (typeof firebridge !== 'undefined' && firebridge.isAdmin && firebridge.isAdmin());
    var scanned = [];
    try {
      var mentees = window.FOCUS_AREAS ? await FOCUS_AREAS.listMentees() : [];
      var menteeUids = mentees.map(function (m) { return m.uid; });
      if (privileged) {
        scanned = menteeUids.filter(function (u) { return read.indexOf(u) === -1; });
      } else {
        // A student sees themselves; a mentor also sees their mentees. Every
        // other read would be denied anyway.
        read = read.filter(function (u) { return u === me || menteeUids.indexOf(u) !== -1; });
        if (me && read.indexOf(me) === -1) read.push(me);
      }
    } catch (e) {
      if (!privileged) read = me ? [me] : [];
    }
    return { assigned: assigned, read: read, scanned: scanned };
  }

  var _names = {};
  async function userName(uid) {
    if (_names[uid]) return _names[uid];
    try {
      var doc = await firebridge.db().collection('users').doc(uid).get();
      _names[uid] = (doc.exists && (doc.data().name || doc.data().displayName)) || uid.slice(0, 8) + '…';
    } catch (e) { _names[uid] = uid.slice(0, 8) + '…'; }
    return _names[uid];
  }

  /* ── the work under a grant, per person ─────────────────────── */

  /* One person's semester + weekly foci that land on any card under this
   * grant. Both reads are independent: someone with visible weeklies but an
   * unreadable semester list still shows what can be seen. */
  async function personWork(uid, cardIds) {
    var hit = function (fa) { return fa.focus_ref && cardIds[fa.focus_ref.id]; };
    var weeks = [], semesters = [], denied = false;
    try {
      var rows = await FOCUS_AREAS.listForRange(
        uid, FOCUS_AREAS.weekIdForOffset(-WEEKS_BACK), FOCUS_AREAS.weekIdForOffset(WEEKS_AHEAD));
      weeks = rows.filter(hit);
    } catch (e) { denied = true; }
    try {
      var sems = await FOCUS_AREAS.listAllSemesterFoci(uid);
      semesters = sems.filter(hit);
    } catch (e) {}
    return { uid: uid, weeks: weeks, semesters: semesters, denied: denied,
             n: weeks.length + semesters.length };
  }

  function outcomeIcon(fa) {
    if (fa.report) {
      var om = (window.FOCUS_AREAS && FOCUS_AREAS.OUTCOME_META[fa.report.outcome]) || {};
      return om.icon ? ICON.render(om.icon) : '·';
    }
    if (fa.status === 'confirmed') return ICON.svg('clock');
    return '◌';
  }
  function statusWord(fa) {
    var m = (window.FOCUS_AREAS && FOCUS_AREAS.STATUS_META[fa.status]) || null;
    return m ? m.label : (fa.status || '');
  }

  /* One weekly focus, as a line under the semester focus it was added to.
   * This is the My Week half of the loop: the student writes these, and the
   * grant is where they add up. */
  function weekLine(fa, byId) {
    var card = fa.focus_ref ? byId[fa.focus_ref.id] : null;
    var aimBit = card && card.id !== undefined
      ? '<a class="rf-combine-pill rr-week-card" href="' + fociUrl(card.id) + '">' +
          ICON.render(card.icon || RD.levelMeta(card.level).icon) + ' ' +
          esc(fa.focus_ref.analysis_title || card.abbr || card.title || card.id) + '</a>'
      : '';
    var tasks = (fa.tasks || []);
    var done = tasks.filter(function (t) { return t.done; }).length;
    return '<li class="rr-week">' +
      '<span class="rr-week-out" title="' + esc(statusWord(fa)) + '">' + outcomeIcon(fa) + '</span>' +
      '<span class="rr-week-id">' + esc(fa.weekId || '') + '</span>' +
      '<span class="rr-week-title">' + esc(fa.title || '(untitled)') + '</span>' +
      aimBit +
      (tasks.length ? '<span class="rr-week-tasks">' + done + '/' + tasks.length + '</span>' : '') +
      (fa.report && fa.report.summary
        ? '<span class="rr-week-sum">' + esc(fa.report.summary) + '</span>' : '') +
    '</li>';
  }

  /* One person: the assignment, then the semester foci assigned on Team
   * Focus, then the weekly foci each student added in My Week beneath the
   * semester focus they belong to. That nesting IS the loop — showing the
   * weeks flat would lose which commitment they were serving. */
  function personBlock(name, role, work, byId) {
    var badge = role
      ? '<span class="rr-role rr-role-' + role + '">' + (role === 'primary' ? 'Primary' : 'Secondary') + '</span>'
      : '';
    if (work.denied) {
      return '<div class="rr-person"><div class="rr-person-head">' +
        '<span class="rf-prog-name">' + esc(name) + '</span>' + badge +
        '<span class="rf-empty-sm">Not visible to you.</span></div></div>';
    }
    if (!work.n) {
      return '<div class="rr-person"><div class="rr-person-head">' +
        '<span class="rf-prog-name">' + esc(name) + '</span>' + badge +
        '<span class="rf-empty-sm">No focus assigned under this grant yet — assign one on ' +
        '<a href="/rm/pages/team-focus.html">Team Focus</a>.</span></div></div>';
    }

    var weeks = work.weeks.slice().sort(function (a, b) {
      return (a.weekId || '').localeCompare(b.weekId || '');
    });
    var groups = work.semesters.map(function (sf) {
      return { sf: sf, weeks: weeks.filter(function (w) { return w.semester_focus_id === sf.id; }) };
    });
    var claimed = {};
    groups.forEach(function (g) { g.weeks.forEach(function (w) { claimed[w.id] = 1; }); });
    var loose = weeks.filter(function (w) { return !claimed[w.id]; });

    var tot = 0, done = 0;
    weeks.forEach(function (fa) { (fa.tasks || []).forEach(function (t) { tot++; if (t.done) done++; }); });

    var body =
      groups.map(function (g) {
        return '<div class="rr-sem">' +
          '<div class="rr-sem-head">' + ICON.svg('academic-cap') + ' <strong>' + esc(g.sf.title || '(untitled)') + '</strong>' +
            '<span class="rr-sem-status">' + esc(statusWord(g.sf)) + '</span>' +
            '<span class="rr-sem-count">' + g.weeks.length + ' week' + (g.weeks.length === 1 ? '' : 's') + '</span>' +
          '</div>' +
          (g.weeks.length
            ? '<ul class="rr-weeks">' + g.weeks.map(function (w) { return weekLine(w, byId); }).join('') + '</ul>'
            : '<p class="rf-empty-sm">No weeks added under this yet — the student adds them in My Week.</p>') +
        '</div>';
      }).join('') +
      (loose.length
        ? '<div class="rr-sem rr-sem-loose">' +
            '<div class="rr-sem-head">Not under a semester focus' +
              '<span class="rr-sem-count">' + loose.length + '</span></div>' +
            '<ul class="rr-weeks">' + loose.map(function (w) { return weekLine(w, byId); }).join('') + '</ul>' +
          '</div>'
        : '');

    return '<details class="rr-person" open>' +
      '<summary class="rr-person-head">' +
        '<span class="rf-prog-name">' + esc(name) + '</span>' + badge +
        (work.semesters.length
          ? '<span class="rf-gr-sem">' + ICON.svg('academic-cap') + ' ' + work.semesters.length + '</span>' : '') +
        '<span class="rf-gr-weeks">' + weeks.length + ' week' + (weeks.length === 1 ? '' : 's') + '</span>' +
        (tot ? '<span class="rf-prog-tasks">' + done + '/' + tot + ' tasks</span>' : '') +
      '</summary>' +
      '<div class="rr-person-body">' + body + '</div>' +
    '</details>';
  }

  /* ── structure sections ─────────────────────────────────────── */

  function roadmapCount(card) {
    if (!window.ROADMAP_DATA || !ROADMAP_DATA.flattenAnalyses) return null;
    try {
      var all = ROADMAP_DATA.flattenAnalyses(card.roadmap) || [];
      if (!all.length) return null;
      var done = all.filter(function (a) { return a.analysis.status === 'done'; }).length;
      return { done: done, total: all.length };
    } catch (e) { return null; }
  }

  function statusPill(card) {
    var m = RD.STATUS_META[card.status] || { label: card.status, color: '#374151', bg: '#e5e7eb' };
    return '<span class="rf-status" style="color:' + m.color + ';background:' + m.bg + '">' + esc(m.label) + '</span>';
  }

  function aimCardRow(aim, allFoci) {
    var rc = roadmapCount(aim);
    var outs = allFoci.filter(function (x) {
      return x.level === 'output' && (x.links.aim_ids || []).indexOf(aim.id) !== -1;
    });
    return '<div class="rf-gr-aim">' +
      '<div class="rf-gr-aim-head">' +
        '<a class="rf-gr-aim-title" href="' + fociUrl(aim.id) + '">' +
          ICON.render(aim.icon || RD.LEVELS.aim.icon) + ' ' + esc(aim.title) + '</a>' +
        statusPill(aim) +
        (rc ? '<span class="rf-mini-status">' + rc.done + '/' + rc.total + ' analyses done</span>' : '') +
      '</div>' +
      (aim.one_liner ? '<p class="rf-card-liner">' + esc(aim.one_liner) + '</p>' : '') +
      (outs.length
        ? '<div class="rf-combine">' + outs.map(function (o) {
            return '<a class="rf-combine-pill" href="' + fociUrl(o.id) + '">' +
              ICON.render(o.icon || RD.LEVELS.output.icon) + ' ' + esc(o.title) + '</a>';
          }).join('') + '</div>'
        : '<p class="rf-empty-sm">Nothing written up from this aim yet.</p>') +
    '</div>';
  }

  /* Every builder draft reachable from the grant — its own draft_refs plus
   * those of its aims and outputs — deduped by draft id. */
  function draftRows(cards) {
    var seen = {}, rows = [];
    cards.forEach(function (c) {
      ((c.links && c.links.draft_refs) || []).forEach(function (r) {
        if (!r || !r.id || seen[r.id]) return;
        seen[r.id] = 1;
        rows.push(r);
      });
    });
    return rows;
  }

  function patentRows(cards) {
    var out = [];
    cards.forEach(function (c) { ((c.links && c.links.patents) || []).forEach(function (p) { out.push(p); }); });
    return out;
  }

  /* ── render ─────────────────────────────────────────────────── */

  async function render(host, grant, pageState) {
    if (!host) return;
    var all = pageState.foci || [];
    var cards = RD.cardsUnderGrant(grant, all);
    var aims = cards.filter(function (c) { return c.level === 'aim'; });
    var outs = cards.filter(function (c) { return c.level === 'output'; });
    // V3.721 — the bibliography lives ON the grant (ref_source), not on a
    // card of its own. Rendered inline below, collapsed: 100+ entries would
    // otherwise bury the aims and the people, which is what the page is for.
    var hasRefs = !!(grant.ref_source && grant.ref_source.draft_id);
    var cardIds = {}; cards.forEach(function (c) { cardIds[c.id] = 1; });
    var byId = {}; all.forEach(function (c) { byId[c.id] = c; });

    var drafts = draftRows(cards);
    var patents = patentRows(cards);
    // V3.851 — the proposer / advisor of an undecided grant card edit it too.
    var canEdit = pageState.canEditCard ? pageState.canEditCard(grant) : pageState.isAdmin;

    host.innerHTML =
      '<div class="rf-gr">' +
        '<section class="rf-sec rf-gr-sec"><div class="rf-sec-head"><h2>' +
          ICON.render(RD.LEVELS.aim.icon) + ' Aims <span class="rf-band-count">' + aims.length + '</span></h2>' +
          (canEdit
            ? '<button class="rf-btn rf-btn-sm rf-btn-primary" data-act="new-child" data-level="aim">' +
                ICON.svg('plus') + ' New aim</button>' : '') +
        '</div>' +
        (aims.length
          ? aims.map(function (a) { return aimCardRow(a, all); }).join('')
          : '<p class="rf-empty-sm">No aims yet — these are the target results this grant needs in order to succeed.</p>') +
        '</section>' +

        '<section class="rf-sec rf-gr-sec"><div class="rf-sec-head"><h2>' +
          ICON.render(RD.LEVELS.output.icon) + ' Outputs <span class="rf-band-count">' + outs.length + '</span></h2>' +
          (canEdit
            ? '<button class="rf-btn rf-btn-sm rf-btn-primary" data-act="new-child" data-level="output">' +
                ICON.svg('plus') + ' New output</button>' : '') +
        '</div>' +
        (outs.length
          ? '<div class="rf-combine">' + outs.map(function (o) {
              return '<a class="rf-combine-pill" href="' + fociUrl(o.id) + '">' +
                ICON.render(o.icon || RD.LEVELS.output.icon) + ' ' + esc(o.title) + ' ' + statusPill(o) + '</a>';
            }).join('') + '</div>'
          : '<p class="rf-empty-sm">Nothing synthesized from this grant’s aims yet.</p>') +
        '</section>' +

        ((drafts.length || patents.length)
          ? '<section class="rf-sec rf-gr-sec"><h2>Drafts &amp; patents</h2><div data-draft-pills>' +
              drafts.map(function (r) {
                return '<span class="rf-draft-pill" data-kind="' + esc(r.kind || 'paper') + '">' +
                  '<a href="/rm/pages/paper-builder.html?paper=' + encodeURIComponent(r.id) + '">' +
                  ICON.svg(r.kind === 'grant' ? 'bookmark-square' : 'pencil-square') + ' ' + esc(r.title || r.id) + '</a>' +
                  '<span class="rf-draft-status" data-status-for="' + esc(r.id) + '">…</span></span>';
              }).join('') +
              patents.map(function (p) {
                return '<span class="rf-draft-pill" data-kind="patent">' + ICON.svg('scale') + ' ' +
                  esc(p.title || p.number || 'Patent') +
                  (p.status ? ' <span class="rf-draft-status">' + esc(p.status) + '</span>' : '') + '</span>';
              }).join('') +
            '</div></section>'
          : '') +

        '<section class="rf-sec rf-gr-sec rf-gr-people"><h2>Work under this grant</h2>' +
          '<p class="rf-empty-sm">Loading…</p>' +
        '</section>' +

        (hasRefs
          ? '<section class="rf-sec rf-gr-sec rf-gr-refs">' +
              '<details class="rr-details">' +
                '<summary><h2>' + ICON.svg('books') + ' References cited ' +
                  '<span class="rf-band-count" data-ref-count>…</span></h2>' +
                  '<span class="rr-summary-hint">show</span></summary>' +
                '<div data-refs><p class="rf-empty-sm">Loading the bibliography…</p></div>' +
              '</details>' +
            '</section>'
          : '') +
      '</div>';

    hydrateDraftStatuses(host, drafts);
    // One library read fills both the count and the list, after paint rather
    // than blocking the review on it.
    if (hasRefs && window.RESEARCH_REFS) {
      RESEARCH_REFS.render(host.querySelector('[data-refs]'), grant, { heading: false })
        .then(function () { return RESEARCH_REFS.count(grant); })
        .then(function (n) {
          var el = host.querySelector('[data-ref-count]');
          if (el) el.textContent = n;
        })
        .catch(function () {});
    }
    await renderPeople(host.querySelector('.rf-gr-people'), grant, cards, cardIds, byId, pageState);
  }

  async function hydrateDraftStatuses(host, drafts) {
    if (!drafts.length || !window.LIBRARY_ASSOC) return;
    try {
      if (LIBRARY_ASSOC.loadDraftInfo) await LIBRARY_ASSOC.loadDraftInfo();
      drafts.forEach(function (r) {
        var info = LIBRARY_ASSOC.resolve ? LIBRARY_ASSOC.resolve(r.id) : null;
        var el = host.querySelector('[data-status-for="' + CSS.escape(r.id) + '"]');
        if (el) el.textContent = (info && info.status) || r.kind || '';
      });
    } catch (e) {}
  }

  async function renderPeople(sec, grant, cards, cardIds, byId, pageState) {
    if (!sec) return;
    var canEdit = pageState.canEditCard ? pageState.canEditCard(grant) : pageState.isAdmin;   // V3.851
    var head = '<div class="rf-sec-head"><h2>Work under this grant</h2>' +
      (canEdit ? '<button class="rf-btn rf-btn-sm" data-act="edit-grant-people">' +
          ICON.svg('pencil') + ' Edit people</button>' : '') + '</div>';
    if (!window.FOCUS_AREAS) { sec.innerHTML = head; return; }

    var r = await roster(grant, cards, pageState);
    var roleOf = {};
    r.assigned.primary.forEach(function (u) { roleOf[u] = 'primary'; });
    r.assigned.secondary.forEach(function (u) { roleOf[u] = 'secondary'; });

    if (!r.read.length && !r.scanned.length) {
      sec.innerHTML = head +
        '<p class="rf-empty-sm">Nobody is on this grant yet.' +
        (canEdit ? ' Use <strong>Edit people</strong> to add them.' : '') + '</p>';
      return;
    }

    // Assigned people are always listed — that is what assigning them means.
    // Scanned people are listed ONLY if they actually have work here.
    var blocks = { primary: [], secondary: [], other: [] };
    for (var i = 0; i < r.read.length; i++) {
      var uid = r.read[i];
      var work = await personWork(uid, cardIds);
      var name = await userName(uid);
      var role = roleOf[uid] || null;
      var html = personBlock(name, role, work, byId);
      if (role) blocks[role].push({ name: name, n: work.n, html: html });
      else if (work.n) blocks.other.push({ name: name, n: work.n, html: html });
    }
    for (var j = 0; j < r.scanned.length; j++) {
      var u2 = r.scanned[j];
      var w2 = await personWork(u2, cardIds);
      if (!w2.n) continue;                       // ← nobody unassociated is listed
      blocks.other.push({ name: await userName(u2), n: w2.n,
                          html: personBlock(await userName(u2), null, w2, byId) });
    }

    function group(rows, title, hint) {
      if (!rows.length) return '';
      rows.sort(function (a, b) { return b.n - a.n || a.name.localeCompare(b.name); });
      return '<div class="rr-group"><h3 class="rr-group-title">' + esc(title) +
        ' <span class="rf-band-count">' + rows.length + '</span></h3>' +
        (hint ? '<p class="rf-empty-sm rr-group-hint">' + hint + '</p>' : '') +
        rows.map(function (x) { return x.html; }).join('') + '</div>';
    }

    var legend = '<div class="rf-prog-legend">' + ICON.svg('check-circle') +
      ' success · ' + ICON.svg('divide') + ' partial · ' + ICON.svg('x-circle') + ' did not work · ' + ICON.svg('clock') +
      ' confirmed, in progress · ◌ proposed · last ' + WEEKS_BACK + ' weeks</div>';

    var body =
      group(blocks.primary, 'Primary', 'Driving this grant.') +
      group(blocks.secondary, 'Secondary', 'A tangential role pushing this forward.') +
      group(blocks.other, 'Also contributing',
            'Not assigned to the grant, but has aligned work to it.');

    sec.innerHTML = head + legend + (body ||
      '<p class="rf-empty-sm">No focus has been aligned to this grant yet. Semester foci are ' +
      'assigned on <a href="/rm/pages/team-focus.html">Team Focus</a>; students add their ' +
      'weeks to them in My Week, and both show up here.</p>');
  }

  /* ── who is on this grant (admin) ───────────────────────────── */

  /* Primary vs secondary in one modal. Writes `member_uids` +
   * `member_roles` on the GRANT card only — the aims and outputs keep their
   * own finer-grained membership, which the review reads separately. */
  async function openPeopleEditor(grant, onDone) {
    var m = RD.modal({ title: 'People on this grant — ' + (grant.title || ''), wide: true });
    m.body.innerHTML = '<p class="rf-empty-sm">Loading the lab roster…</p>';

    var roster = [];
    try {
      var snap = await firebridge.db().collection('users').get();
      roster = snap.docs.map(function (d) { return Object.assign({ uid: d.id }, d.data()); })
        .filter(function (u) { return u.role && u.role !== 'guest'; })
        .filter(function (u) { return u.category !== 'alumni' && u.category !== 'guest'; })
        .map(function (u) { return { uid: u.uid, name: u.name || u.email || u.uid }; })
        .sort(function (a, b) { return a.name.localeCompare(b.name); });
    } catch (e) {}

    var picked = {};
    (grant.member_uids || []).forEach(function (u) {
      picked[u] = isSecondary(grant, u) ? 'secondary' : 'primary';
    });

    m.body.innerHTML =
      '<p class="rf-hint">Primary people drive the grant. Secondary people have a ' +
      'tangential role pushing it forward. Anyone not listed here still shows under ' +
      '<em>Also contributing</em> if they align work to it.</p>' +
      '<div class="rr-people-edit">' +
        (roster.length ? roster.map(function (u) {
          var cur = picked[u.uid] || '';
          return '<div class="rr-pe-row"><span class="rr-pe-name">' + esc(u.name) + '</span>' +
            ['', 'primary', 'secondary'].map(function (v) {
              return '<label class="rr-pe-opt"><input type="radio" name="pe-' + esc(u.uid) + '" ' +
                'data-pe="' + esc(u.uid) + '" value="' + v + '"' + (cur === v ? ' checked' : '') + '> ' +
                (v === '' ? 'Not on it' : v === 'primary' ? 'Primary' : 'Secondary') + '</label>';
            }).join('') +
          '</div>';
        }).join('') : '<p class="rf-empty-sm">No lab members found.</p>') +
      '</div>' +
      '<div class="rf-modal-actions"><span class="rf-modal-err" hidden></span>' +
        '<button type="button" class="rf-btn" data-act="cancel">Cancel</button>' +
        '<button type="button" class="rf-btn rf-btn-primary" data-act="save">Save</button>' +
      '</div>';

    m.body.addEventListener('click', async function (e) {
      var act = e.target.closest('[data-act]');
      if (!act) return;
      if (act.getAttribute('data-act') === 'cancel') { m.close(); return; }
      if (act.getAttribute('data-act') !== 'save') return;
      act.disabled = true;
      var uids = [], roles = {};
      m.body.querySelectorAll('[data-pe]:checked').forEach(function (input) {
        var v = input.value;
        if (!v) return;
        var uid = input.getAttribute('data-pe');
        uids.push(uid);
        // Only 'secondary' is stored; primary is the absence of a demotion,
        // which keeps pre-V3.722 free-text roles from being clobbered.
        if (v === 'secondary') roles[uid] = 'secondary';
      });
      try {
        await RD.update(grant.id, { member_uids: uids, member_roles: roles });
        m.close();
        if (window.TOAST) TOAST.success(uids.length + ' on this grant.');
        if (onDone) onDone();
      } catch (err) {
        var el = m.body.querySelector('.rf-modal-err');
        if (el) { el.textContent = err && err.message; el.hidden = false; }
        act.disabled = false;
      }
    });
  }

  window.GRANT_REVIEW = { render: render, openPeopleEditor: openPeopleEditor };
})();
