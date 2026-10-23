/* research-create.js — V3.549 (Research Foci: create-from-focus actions)
 *
 * The research page as an ACTION hub — the PI can, from a focus card:
 *
 *   openPaper(foci, onDone)       — spawn a real paper-builder draft with
 *                                   students assigned, linked into the
 *                                   card's draft_refs.
 *   openGrantIdea(foci, onDone)   — V3.717: grants are their own LEVEL, and
 *                                   grant_meta is edited inline on the grant
 *                                   card's own form, so this now delegates to
 *                                   the composer. Kept as a stable entry
 *                                   point; the standalone-idea path creates a
 *                                   grant card pre-linked to its concept.
 *   promoteGrantIdea(foci, onDone)— turn a grant card into a real
 *                                   paper_type:'grant' draft in the builder,
 *                                   stamping grant_meta.promoted_draft_id.
 *
 * Paper/grant rows are appended to projects/papers.json exactly the way the
 * builder's own createPaper() does (same field shape, paper-builder.js:263)
 * — the api route lands them in the `projects` collection, where the
 * onPaperAuthorSync Cloud Function (V3.473) materializes
 * papers/{id}.authorUids server-side, so assigned students immediately see
 * the draft in their PMR paper-writing block and focus paper-link pickers.
 * Globals: window.RESEARCH_CREATE.
 */
(function () {
  'use strict';

  var RD = window.RESEARCH_DATA;
  var esc = RD.esc;

  function toast(kind, msg) { if (window.TOAST && TOAST[kind]) TOAST[kind](msg); }

  async function loadRoster() {
    try {
      var snap = await firebridge.db().collection('users').get();
      return snap.docs.map(function (d) { return Object.assign({ uid: d.id }, d.data()); })
        .filter(function (u) { return u.role && u.role !== 'guest' && u.category !== 'alumni' && u.category !== 'guest'; })
        .map(function (u) { return { uid: u.uid, name: u.name || u.email || u.uid }; })
        .sort(function (a, b) { return a.name.localeCompare(b.name); });
    } catch (e) { return []; }
  }

  /* Append a row to projects/papers.json — the builder's createPaper()
   * shape verbatim. Returns the new row. */
  async function appendPaperRow(fields) {
    var user = firebridge.getUser();
    var profile = firebridge.getProfile ? (firebridge.getProfile() || {}) : {};
    var data = await api.load('projects/papers.json');
    var arr = (data && data.papers) || [];
    if (arr.some(function (p) { return p.id === fields.id; })) {
      throw new Error('A paper with the slug "' + fields.id + '" already exists.');
    }
    var row = {
      id: fields.id,
      title: fields.title,
      target_journal: fields.target_journal || 'TBD',
      status: 'drafting',
      lead_author: fields.lead_author_name || profile.name || (user && user.email) || 'Unknown',
      lead_author_uid: fields.lead_author_uid || (user ? user.uid : ''),
      lead_author_email: fields.lead_author_email || (user ? (user.email || '') : ''),
      coauthor_uids: fields.coauthor_uids || [],
      coauthor_emails: [],
      template_id: fields.template_id || 'generic',
      paper_type: fields.paper_type || 'journal',
      grant_subtype: fields.grant_subtype || null,
      repo_path: '',
      repo_org: '',
      notes: fields.notes || '',
    };
    arr.push(row);
    await api.save('projects/papers.json', { papers: arr });
    return row;
  }

  /* Link a spawned draft onto the focus card + attach its students. */
  async function linkDraftToFocus(f, row, kind, studentUids) {
    var links = JSON.parse(JSON.stringify(f.links || {}));
    links.draft_refs = links.draft_refs || [];
    links.draft_refs.push({ id: row.id, title: row.title, kind: kind });
    var members = (f.member_uids || []).slice();
    (studentUids || []).forEach(function (uid) { if (members.indexOf(uid) === -1) members.push(uid); });
    var patch = { links: links, member_uids: members };
    if (kind === 'grant' && f.grant_meta) {
      patch['grant_meta.promoted_draft_id'] = row.id;
    }
    await RD.update(f.id, patch);
  }

  /* ── ＋ New paper from this focus ───────────────────────────── */

  async function openPaper(f, onDone) {
    var m = RD.modal({ title: '＋ New paper — ' + f.title });
    m.body.innerHTML = '<p class="rf-empty-sm">Loading roster…</p>';
    var roster = await loadRoster();
    var meUid = firebridge.getUser().uid;

    m.body.innerHTML =
      '<div class="rf-field rf-grow"><label>Paper title</label><input type="text" data-title placeholder="Working title"></div>' +
      '<div class="rf-field-row">' +
        '<div class="rf-field rf-grow"><label>Slug (id)</label><input type="text" data-slug placeholder="auto from title"></div>' +
        '<div class="rf-field rf-grow"><label>Target journal</label><input type="text" data-journal placeholder="TBD"></div>' +
      '</div>' +
      '<div class="rf-field"><label>Lead author</label><select data-lead>' +
        roster.map(function (u) {
          return '<option value="' + esc(u.uid) + '"' + (u.uid === meUid ? ' selected' : '') + '>' + esc(u.name) + '</option>';
        }).join('') + '</select></div>' +
      '<div class="rf-field"><label>Assign students (coauthors — also attached to this focus)</label>' +
        '<div class="rf-check-list">' + roster.filter(function (u) { return u.uid !== meUid; }).map(function (u) {
          return '<label class="rf-check"><input type="checkbox" data-student="' + esc(u.uid) + '"> ' + esc(u.name) + '</label>';
        }).join('') + '</div></div>' +
      '<div class="rf-modal-actions"><span class="rf-modal-err" hidden></span>' +
        '<button type="button" class="rf-btn" data-act="cancel">Cancel</button>' +
        '<button type="button" class="rf-btn rf-btn-primary" data-act="create">Create paper</button>' +
      '</div>';

    var errEl = m.body.querySelector('.rf-modal-err');
    function showErr(msg) { errEl.textContent = msg || ''; errEl.hidden = !msg; }

    m.body.addEventListener('click', async function (e) {
      var act = e.target.closest('[data-act]');
      if (!act) return;
      if (act.getAttribute('data-act') === 'cancel') { m.close(); return; }
      if (act.getAttribute('data-act') !== 'create') return;

      var title = m.body.querySelector('[data-title]').value.trim();
      if (!title) { showErr('Title is required.'); return; }
      var slug = RD.slugify(m.body.querySelector('[data-slug]').value.trim() || title);
      if (!slug) { showErr('Slug could not be derived — type one.'); return; }
      var leadUid = m.body.querySelector('[data-lead]').value;
      var lead = roster.filter(function (u) { return u.uid === leadUid; })[0];
      var students = [];
      m.body.querySelectorAll('[data-student]:checked').forEach(function (c) { students.push(c.getAttribute('data-student')); });
      var coauthors = students.slice();
      if (leadUid !== meUid && coauthors.indexOf(meUid) === -1) coauthors.push(meUid); // PI stays on the paper

      act.disabled = true; act.textContent = 'Creating…';
      try {
        var row = await appendPaperRow({
          id: slug, title: title,
          target_journal: m.body.querySelector('[data-journal]').value.trim() || 'TBD',
          lead_author_uid: leadUid,
          lead_author_name: lead ? lead.name : '',
          coauthor_uids: coauthors.filter(function (u) { return u !== leadUid; }),
          paper_type: 'journal',
        });
        var attach = students.slice(); if (attach.indexOf(leadUid) === -1 && leadUid !== meUid) attach.push(leadUid);
        await linkDraftToFocus(f, row, 'paper', attach);
        m.close();
        toast('success', 'Paper created and linked.');
        if (onDone) await onDone();
        if (confirm('Open "' + title + '" in the paper builder?')) {
          window.location.href = '/rm/pages/paper-builder.html?paper=' + encodeURIComponent(slug);
        }
      } catch (err) {
        showErr(err && err.message || 'Create failed.');
        act.disabled = false; act.textContent = 'Create paper';
      }
    });
  }

  /* ── 💡 New grant idea ──────────────────────────────────────── */

  function openGrantIdea(f, onDone, parentConcept) {
    /* V3.717 — a grant is a card in its own right, and its agency /
     * mechanism / deadline / scope live on that card's own edit form
     * (research-composer.js). Editing an existing grant therefore hands
     * straight over rather than keeping a second editor for the same
     * fields — two editors for one shape is how they drift.
     *
     * The modal below survives only for the CREATE path: capturing a grant
     * from a concept before there is a card to edit. */
    if (f && f.level === 'grant' && window.RESEARCH_COMPOSER) {
      RESEARCH_COMPOSER.openEdit(f, onDone);
      return;
    }
    var isNew = !f;
    var gm = (f && f.grant_meta) || {};
    var m = RD.modal({
      title: isNew
        ? 'New grant idea' + (parentConcept ? ' — ' + parentConcept.title : '')
        : 'Grant idea — ' + f.title,
      wide: true,
    });

    m.body.innerHTML =
      (isNew ? '<div class="rf-field rf-grow"><label>Idea title</label><input type="text" data-gi-title placeholder="e.g. GELS for prostate microenvironments"></div>' +
               '<div class="rf-field rf-grow"><label>One-liner</label><input type="text" data-gi-liner placeholder="Card-face tagline"></div>'
             : '') +
      '<div class="rf-field-row">' +
        '<div class="rf-field rf-grow"><label>Agency</label><input type="text" data-gi-agency value="' + esc(gm.agency || '') + '" placeholder="NSF / NIH / DoD…"></div>' +
        '<div class="rf-field rf-grow"><label>Mechanism</label><input type="text" data-gi-mech value="' + esc(gm.mechanism || '') + '" placeholder="CAREER / R01 / R21…"></div>' +
      '</div>' +
      '<div class="rf-field-row">' +
        '<div class="rf-field rf-grow"><label>Where to submit</label><input type="text" data-gi-submit value="' + esc(gm.submit_to || '') + '" placeholder="Program / solicitation name"></div>' +
        '<div class="rf-field rf-grow"><label>Submission URL</label><input type="text" data-gi-url value="' + esc(gm.submission_url || '') + '" placeholder="https://…"></div>' +
        '<div class="rf-field"><label>Target deadline</label><input type="date" data-gi-deadline value="' + esc(gm.target_deadline && gm.target_deadline !== 'TBD' ? gm.target_deadline : '') + '"></div>' +
      '</div>' +
      '<div class="rf-field rf-grow"><label>Scope — aims sketch, budget ballpark, who does what</label>' +
        '<div class="rf-richtext-edit" contenteditable="true" data-gi-scope>' + (gm.scope_html ? RD.sanitizeHtml(gm.scope_html) : '') + '</div></div>' +
      '<div class="rf-modal-actions"><span class="rf-modal-err" hidden></span>' +
        '<button type="button" class="rf-btn" data-act="cancel">Cancel</button>' +
        '<button type="button" class="rf-btn rf-btn-primary" data-act="save">' + (isNew ? 'Create idea card' : 'Save idea') + '</button>' +
      '</div>';

    var errEl = m.body.querySelector('.rf-modal-err');
    function showErr(msg) { errEl.textContent = msg || ''; errEl.hidden = !msg; }
    function gv(sel) { var el = m.body.querySelector(sel); return el ? el.value.trim() : ''; }

    m.body.addEventListener('click', async function (e) {
      var act = e.target.closest('[data-act]');
      if (!act) return;
      if (act.getAttribute('data-act') === 'cancel') { m.close(); return; }
      if (act.getAttribute('data-act') !== 'save') return;

      var grantMeta = {
        agency: gv('[data-gi-agency]'),
        mechanism: gv('[data-gi-mech]'),
        submit_to: gv('[data-gi-submit]'),
        submission_url: gv('[data-gi-url]'),
        target_deadline: gv('[data-gi-deadline]') || 'TBD',
        scope_html: RD.sanitizeHtml(m.body.querySelector('[data-gi-scope]').innerHTML),
        promoted_draft_id: gm.promoted_draft_id || null,
      };
      act.disabled = true;
      try {
        if (isNew) {
          var title = gv('[data-gi-title]');
          if (!title) { showErr('Title is required.'); act.disabled = false; return; }
          await RD.create({
            // V3.717 — a GRANT card, starting at the front of its own
            // lifecycle. Pre-linked to the concept it came from, which is
            // what the concept's Grants section reads back.
            level: 'grant', title: title, one_liner: gv('[data-gi-liner]'),
            status: 'in_preparation', status_source: 'manual', grant_meta: grantMeta,
            links: parentConcept ? { concept_ids: [parentConcept.id] } : {},
          });
        } else {
          await RD.update(f.id, { grant_meta: grantMeta });
        }
        m.close();
        toast('success', 'Grant saved.');
        if (onDone) onDone();
      } catch (err) {
        showErr(err && err.message || 'Save failed.');
        act.disabled = false;
      }
    });
  }

  /* ── Promote grant idea → real grant draft ──────────────────── */

  async function promoteGrantIdea(f, onDone) {
    var gm = f.grant_meta || {};
    if (gm.promoted_draft_id) { toast('info', 'Already promoted.'); return; }
    if (!confirm('Create a grant draft in the paper builder for "' + f.title + '"?')) return;
    var slug = RD.slugify(f.id + '-grant') || RD.slugify(f.title);
    try {
      var row = await appendPaperRow({
        id: slug,
        title: f.title,
        target_journal: gm.agency ? (gm.agency + (gm.mechanism ? ' ' + gm.mechanism : '')) : 'TBD',
        paper_type: 'grant',
        grant_subtype: gm.mechanism ? RD.slugify(gm.agency + '-' + gm.mechanism) : null,
        notes: gm.submit_to ? ('Submit to: ' + gm.submit_to + (gm.target_deadline && gm.target_deadline !== 'TBD' ? ' by ' + gm.target_deadline : '')) : '',
      });
      await linkDraftToFocus(f, row, 'grant', f.member_uids || []);
      // Only output cards take their lifecycle from the draft. A GRANT's
      // status is manual, always (V3.717) — promoting it to a builder draft
      // is not the same event as submitting it, so nothing moves here.
      if (f.level === 'output') await RD.update(f.id, { status: 'drafting', status_source: 'derived' });
      if (f.level === 'grant') await RD.update(f.id, { source_draft_id: row.id });
      toast('success', 'Grant draft created.');
      if (onDone) await onDone();
      if (confirm('Open the grant in the builder?')) {
        window.location.href = '/rm/pages/paper-builder.html?paper=' + encodeURIComponent(slug);
      }
    } catch (err) {
      toast('error', 'Promote failed: ' + (err && err.message));
    }
  }

  window.RESEARCH_CREATE = {
    openPaper: openPaper,
    openGrantIdea: openGrantIdea,
    promoteGrantIdea: promoteGrantIdea,
  };
})();
