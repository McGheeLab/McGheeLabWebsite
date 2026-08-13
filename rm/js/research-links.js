/* research-links.js — V3.548 (Research Foci attachments)
 *
 * The admin "Manage links & attachments" modal for a focus card. One modal
 * with sections for: what it combines (cross-level specialty/concept links),
 * papers/grants (drafts) + patents, the linked Lab Theme, trainings, and
 * attached students. Opening with a `part` scrolls to that section.
 *
 * Draft status is resolved live via LIBRARY_ASSOC (never stored on the ref).
 * All writes go through RESEARCH_DATA.update (admin-only, direct Firestore).
 * Globals: window.RESEARCH_LINKS.
 */
(function () {
  'use strict';

  var RD = window.RESEARCH_DATA;
  var esc = RD.esc;

  // Known training slugs (static training-<slug>.html pages). Admin may add
  // any slug via the free-text row.
  var TRAINING_SLUGS = [
    'microscope-basics', 'confocal', 'epifluorescence', 'camera-selection',
    'image-train', 'scientific-communication', 'phd-triangle',
    'paper-writing', 'paper-abstract', 'paper-introduction', 'paper-methods',
    'paper-results', 'paper-discussion', 'paper-peer-review',
    'rm-essentials', 'rm-daily-research',
  ];

  function toast(kind, msg) { if (window.TOAST && TOAST[kind]) TOAST[kind](msg); }

  async function loadRoster() {
    try {
      var snap = await firebridge.db().collection('users').get();
      return snap.docs.map(function (d) { return Object.assign({ uid: d.id }, d.data()); })
        .filter(function (u) { return u.role && u.role !== 'guest'; })
        .filter(function (u) { return u.category !== 'alumni' && u.category !== 'guest'; })
        .map(function (u) { return { uid: u.uid, name: u.name || u.email || u.uid, category: u.category || '' }; })
        .sort(function (a, b) { return a.name.localeCompare(b.name); });
    } catch (e) { return []; }
  }
  async function loadThemes() {
    try {
      var snap = await firebridge.db().collection('labThemes').get();
      return snap.docs.map(function (d) { return { id: d.id, name: (d.data().name || d.id), archived: !!d.data().archived }; })
        .filter(function (t) { return !t.archived; })
        .sort(function (a, b) { return a.name.localeCompare(b.name); });
    } catch (e) { return []; }
  }

  async function openEditor(f, allFoci, part, onDone) {
    var m = RD.modal({ title: 'Links & attachments — ' + f.title, wide: true });
    m.body.innerHTML = '<p class="rf-empty-sm">Loading…</p>';

    var roster = await loadRoster();
    var themes = await loadThemes();
    var draftMap = null;
    if (window.LIBRARY_ASSOC && LIBRARY_ASSOC.loadDraftInfo) { try { draftMap = await LIBRARY_ASSOC.loadDraftInfo(); } catch (e) {} }

    // Working copies.
    var links = JSON.parse(JSON.stringify(f.links || {}));
    links.specialty_ids = links.specialty_ids || [];
    links.concept_ids = links.concept_ids || [];
    links.draft_refs = links.draft_refs || [];
    links.patents = links.patents || [];
    links.training_slugs = links.training_slugs || [];
    var memberUids = (f.member_uids || []).slice();
    var memberRoles = Object.assign({}, f.member_roles || {});

    function crossOptions() {
      // specialties always selectable; concepts too for output cards.
      var pools = [{ label: 'Specialties', level: 'specialty', arr: links.specialty_ids }];
      if (f.level === 'output') pools.push({ label: 'Concepts', level: 'concept', arr: links.concept_ids });
      return pools.map(function (pool) {
        var opts = allFoci.filter(function (x) { return x.level === pool.level && x.id !== f.id; });
        return '<div class="rf-linkgroup"><h4>' + pool.label + '</h4>' +
          (opts.length ? opts.map(function (o) {
            var on = pool.arr.indexOf(o.id) !== -1;
            return '<label class="rf-check"><input type="checkbox" data-cross="' + pool.level + '" value="' + esc(o.id) + '"' + (on ? ' checked' : '') + '> ' + esc(o.icon || '') + ' ' + esc(o.title) + '</label>';
          }).join('') : '<p class="rf-empty-sm">None yet.</p>') + '</div>';
      }).join('');
    }
    function draftOptions() {
      var entries = draftMap ? Array.from(draftMap.values()) : [];
      entries.sort(function (a, b) { return (a.title || '').localeCompare(b.title || ''); });
      var linkedIds = links.draft_refs.map(function (r) { return r.id; });
      return entries.length ? entries.map(function (d) {
        var on = linkedIds.indexOf(d.id) !== -1;
        return '<label class="rf-check"><input type="checkbox" data-draft="' + esc(d.id) + '" data-kind="' + esc(d.kind) + '" data-title="' + esc(d.title) + '"' + (on ? ' checked' : '') + '> ' +
          (d.kind === 'grant' ? '📑 ' : '📝 ') + esc(d.title) + ' <span class="rf-mini-status">' + esc(d.status || '') + '</span></label>';
      }).join('') : '<p class="rf-empty-sm">No paper or grant drafts found.</p>';
    }
    function patentRows() {
      return links.patents.map(function (p, i) {
        return '<div class="rf-patent-row" data-patent-i="' + i + '">⚖️ ' + esc(p.title || '') +
          (p.number ? ' · ' + esc(p.number) : '') + (p.status ? ' · ' + esc(p.status) : '') +
          ' <button type="button" class="rf-btn-danger rf-btn-xs" data-patent-rm="' + i + '">✕</button></div>';
      }).join('');
    }
    function themeOptions() {
      return '<select data-theme><option value="">— none —</option>' +
        themes.map(function (t) { return '<option value="' + esc(t.id) + '"' + (links.theme_id === t.id ? ' selected' : '') + '>' + esc(t.name) + '</option>'; }).join('') +
        '</select>';
    }
    function trainingRows() {
      var set = {}; links.training_slugs.forEach(function (s) { set[s] = 1; });
      var all = TRAINING_SLUGS.slice();
      links.training_slugs.forEach(function (s) { if (all.indexOf(s) === -1) all.push(s); });
      return all.map(function (s) {
        return '<label class="rf-check"><input type="checkbox" data-training="' + esc(s) + '"' + (set[s] ? ' checked' : '') + '> 🎓 ' + esc(s) + '</label>';
      }).join('');
    }
    function peopleRows() {
      return roster.map(function (u) {
        var on = memberUids.indexOf(u.uid) !== -1;
        return '<label class="rf-check"><input type="checkbox" data-member="' + esc(u.uid) + '"' + (on ? ' checked' : '') + '> ' + esc(u.name) +
          ' <input type="text" class="rf-role-in" data-role="' + esc(u.uid) + '" placeholder="role" value="' + esc(memberRoles[u.uid] || '') + '"></label>';
      }).join('');
    }

    m.body.innerHTML =
      '<section class="rf-link-sec" data-sec="combine"><h3>Combines</h3>' + crossOptions() + '</section>' +
      '<section class="rf-link-sec" data-sec="drafts"><h3>Papers &amp; grants</h3>' + draftOptions() +
        '<h4>Patents</h4><div data-patents>' + patentRows() + '</div>' +
        '<div class="rf-patent-add"><input type="text" data-pt-title placeholder="Patent title"><input type="text" data-pt-number placeholder="Number"><input type="text" data-pt-status placeholder="status"><button type="button" class="rf-btn rf-btn-xs" data-pt-add>＋ Add patent</button></div>' +
      '</section>' +
      '<section class="rf-link-sec" data-sec="theme"><h3>Lab Theme</h3>' + themeOptions() + '</section>' +
      '<section class="rf-link-sec" data-sec="trainings"><h3>Trainings</h3>' + trainingRows() + '</section>' +
      '<section class="rf-link-sec" data-sec="people"><h3>Attached students</h3>' + peopleRows() + '</section>' +
      '<div class="rf-modal-actions"><span class="rf-modal-err" hidden></span>' +
        '<button type="button" class="rf-btn" data-act="cancel">Cancel</button>' +
        '<button type="button" class="rf-btn rf-btn-primary" data-act="save">Save</button>' +
      '</div>';

    if (part) { var sec = m.body.querySelector('[data-sec="' + part + '"]'); if (sec) sec.scrollIntoView({ block: 'start' }); }

    m.body.addEventListener('click', function (e) {
      var addPt = e.target.closest('[data-pt-add]');
      if (addPt) {
        var title = m.body.querySelector('[data-pt-title]').value.trim();
        if (!title) return;
        links.patents.push({ id: RD.newId('pt'), title: title, number: m.body.querySelector('[data-pt-number]').value.trim(), status: m.body.querySelector('[data-pt-status]').value.trim() });
        m.body.querySelector('[data-patents]').innerHTML = patentRows();
        m.body.querySelector('[data-pt-title]').value = ''; m.body.querySelector('[data-pt-number]').value = ''; m.body.querySelector('[data-pt-status]').value = '';
        return;
      }
      var rmPt = e.target.closest('[data-patent-rm]');
      if (rmPt) { links.patents.splice(+rmPt.getAttribute('data-patent-rm'), 1); m.body.querySelector('[data-patents]').innerHTML = patentRows(); return; }
      var act = e.target.closest('[data-act]');
      if (!act) return;
      if (act.getAttribute('data-act') === 'cancel') { m.close(); return; }
      if (act.getAttribute('data-act') === 'save') { save(act); return; }
    });

    function collect() {
      links.specialty_ids = []; links.concept_ids = [];
      m.body.querySelectorAll('[data-cross]:checked').forEach(function (c) {
        (c.getAttribute('data-cross') === 'specialty' ? links.specialty_ids : links.concept_ids).push(c.value);
      });
      links.draft_refs = [];
      m.body.querySelectorAll('[data-draft]:checked').forEach(function (c) {
        links.draft_refs.push({ id: c.getAttribute('data-draft'), title: c.getAttribute('data-title'), kind: c.getAttribute('data-kind') });
      });
      links.theme_id = m.body.querySelector('[data-theme]').value || null;
      links.training_slugs = [];
      m.body.querySelectorAll('[data-training]:checked').forEach(function (c) { links.training_slugs.push(c.getAttribute('data-training')); });
      memberUids = []; memberRoles = {};
      m.body.querySelectorAll('[data-member]:checked').forEach(function (c) {
        var uid = c.getAttribute('data-member'); memberUids.push(uid);
        var r = m.body.querySelector('[data-role="' + uid + '"]'); if (r && r.value.trim()) memberRoles[uid] = r.value.trim();
      });
    }

    async function save(btn) {
      collect();
      btn.disabled = true;
      try {
        await RD.update(f.id, { links: links, member_uids: memberUids, member_roles: memberRoles });
        m.close();
        toast('success', 'Attachments saved.');
        if (onDone) onDone();
      } catch (err) {
        var el = m.body.querySelector('.rf-modal-err'); if (el) { el.textContent = err && err.message; el.hidden = false; }
        btn.disabled = false;
      }
    }
  }

  /* V3.554 (reworked V3.557) — add existing outputs with ONE CLICK EACH.
   * The list is the lab's REAL papers (LIBRARY_ASSOC roster, grants excluded
   * — V3.558: grants live within concepts) plus
   * any authored output cards (patents / planned). Checking a paper/grant
   * that has no card yet AUTO-CREATES a draft-backed output card
   * (source_draft_id — title + status derive live from the record, nothing
   * to type); with a `parent` concept/specialty, checked outputs are also
   * linked under it (links.concept_ids / specialty_ids on the output — the
   * established "output points up" direction). parent may be null (hub
   * "⤵ Existing" button): then checking just materializes cards. */
  async function openOutputLinker(parent, allFoci, onDone) {
    var key = parent ? (parent.level === 'specialty' ? 'specialty_ids' : 'concept_ids') : null;
    var m = RD.modal({ title: parent ? 'Outputs — ' + parent.title : 'Add existing outputs' });
    m.body.innerHTML = '<p class="rf-empty-sm">Loading papers…</p>';

    var draftMap = new Map();
    if (window.LIBRARY_ASSOC && LIBRARY_ASSOC.loadDraftInfo) {
      try { draftMap = await LIBRARY_ASSOC.loadDraftInfo(); } catch (e) {}
    }
    var outputs = (allFoci || []).filter(function (x) { return x.level === 'output'; });
    var cardByDraft = {};
    outputs.forEach(function (o) { if (o.source_draft_id) cardByDraft[o.source_draft_id] = o; });
    // Authored cards (patents, planned outputs) have no backing draft.
    var authored = outputs.filter(function (o) { return !o.source_draft_id; });

    // V3.558 — outputs are papers/patents; grants live within concepts
    // (linked there via openGrantLinker), so they don't appear here.
    var drafts = Array.from(draftMap.values())
      .filter(function (d) { return d.kind !== 'grant'; })
      .sort(function (a, b) { return (a.title || '').localeCompare(b.title || ''); });

    function linkedToParent(o) {
      return parent && o && ((o.links && o.links[key]) || []).indexOf(parent.id) !== -1;
    }

    m.body.innerHTML =
      '<p class="rf-hint">' + (parent
        ? 'Check the papers that belong to this ' + esc(parent.level) + ' — each becomes (or already is) its own output card, no typing needed.'
        : 'Check papers to turn each into its own output card on the research map.') + '</p>' +
      (drafts.length
        ? '<div class="rf-check-list">' + drafts.map(function (d) {
            var card = cardByDraft[d.id];
            var on = parent ? linkedToParent(card) : !!card;
            var dis = (!parent && card) ? ' disabled' : '';
            return '<label class="rf-check"><input type="checkbox" data-draft-out="' + esc(d.id) + '" data-kind="' + esc(d.kind) + '" data-title="' + esc(d.title) + '"' + (on ? ' checked' : '') + dis + '> ' +
              (d.kind === 'grant' ? '📑 ' : '📝 ') + esc(d.title) +
              ' <span class="rf-mini-status">' + esc(d.status || '') + (!parent && card ? ' · already a card' : '') + '</span></label>';
          }).join('') + '</div>'
        : '<p class="rf-empty-sm">No papers found yet.</p>') +
      (parent && authored.length
        ? '<h4 class="rf-link-h4">Other output cards (patents / planned)</h4>' +
          '<div class="rf-check-list">' + authored.map(function (o) {
            return '<label class="rf-check"><input type="checkbox" data-card-out="' + esc(o.id) + '"' + (linkedToParent(o) ? ' checked' : '') + '> ' +
              esc(o.icon || '') + ' ' + esc(o.title) + '</label>';
          }).join('') + '</div>'
        : '') +
      '<div class="rf-modal-actions"><span class="rf-modal-err" hidden></span>' +
        '<button type="button" class="rf-btn" data-act="cancel">Cancel</button>' +
        '<button type="button" class="rf-btn rf-btn-primary" data-act="save">Save</button>' +
      '</div>';

    m.body.addEventListener('click', function (e) {
      var act = e.target.closest('[data-act]');
      if (!act) return;
      if (act.getAttribute('data-act') === 'cancel') { m.close(); return; }
      if (act.getAttribute('data-act') !== 'save') return;
      save(act);
    });

    // A draft-backed card's id: prefer the draft id (kebab slug) unless a
    // non-output card already claims it in the shared researchFoci namespace.
    function cardIdFor(draftId) {
      var clash = (allFoci || []).some(function (x) { return x.id === draftId && x.level !== 'output'; });
      return clash ? 'out-' + draftId : draftId;
    }

    async function ensureCard(draftId, title, kind) {
      var existing = cardByDraft[draftId];
      if (existing) return existing;
      var created = await RD.create({
        id: cardIdFor(draftId),
        level: 'output',
        title: title,                     // snapshot fallback; render derives live
        source_draft_id: draftId,
        status: 'drafting',
        status_source: 'derived',
        links: { draft_refs: [{ id: draftId, title: title, kind: kind }] },
      });
      cardByDraft[draftId] = created;
      return created;
    }

    async function setParentLink(card, want) {
      if (!parent || !card) return;
      var ids = ((card.links && card.links[key]) || []).slice();
      var have = ids.indexOf(parent.id) !== -1;
      if (want === have) return;
      if (want) ids.push(parent.id);
      else ids = ids.filter(function (x) { return x !== parent.id; });
      var patch = {}; patch['links.' + key] = ids;
      await RD.update(card.id, patch);
      card.links = card.links || {}; card.links[key] = ids;
    }

    async function save(btn) {
      btn.disabled = true;
      try {
        // Papers & grants: create missing cards, then sync the parent link.
        var boxes = m.body.querySelectorAll('[data-draft-out]');
        for (var i = 0; i < boxes.length; i++) {
          var cb = boxes[i];
          if (cb.disabled) continue;
          var draftId = cb.getAttribute('data-draft-out');
          var card = cardByDraft[draftId];
          if (cb.checked) {
            card = await ensureCard(draftId, cb.getAttribute('data-title'), cb.getAttribute('data-kind'));
            await setParentLink(card, true);
          } else if (card) {
            await setParentLink(card, false);   // unlink from parent; card stays
          }
        }
        // Authored cards (parent mode only): sync the link.
        var cardBoxes = m.body.querySelectorAll('[data-card-out]');
        for (var j = 0; j < cardBoxes.length; j++) {
          var ob = cardBoxes[j];
          var o = outputs.filter(function (x) { return x.id === ob.getAttribute('data-card-out'); })[0];
          await setParentLink(o, ob.checked);
        }
        m.close();
        toast('success', 'Outputs updated.');
        if (onDone) onDone();
      } catch (err) {
        var el = m.body.querySelector('.rf-modal-err'); if (el) { el.textContent = err && err.message; el.hidden = false; }
        btn.disabled = false;
      }
    }
  }

  /* V3.558 — link an existing GRANT draft to a concept (grants live within
   * concepts). Writes the concept's own links.draft_refs (kind 'grant');
   * status renders live via the resolver. The one-grant-per-concept soft
   * warning happens in the caller (research.js). */
  async function openGrantLinker(concept, onDone) {
    var m = RD.modal({ title: 'Link a grant — ' + concept.title });
    m.body.innerHTML = '<p class="rf-empty-sm">Loading grants…</p>';
    var draftMap = new Map();
    if (window.LIBRARY_ASSOC && LIBRARY_ASSOC.loadDraftInfo) {
      try { draftMap = await LIBRARY_ASSOC.loadDraftInfo(); } catch (e) {}
    }
    var grants = Array.from(draftMap.values())
      .filter(function (d) { return d.kind === 'grant'; })
      .sort(function (a, b) { return (a.title || '').localeCompare(b.title || ''); });
    var linked = ((concept.links && concept.links.draft_refs) || [])
      .filter(function (r) { return r.kind === 'grant'; })
      .map(function (r) { return r.id; });

    m.body.innerHTML =
      (grants.length
        ? '<div class="rf-check-list">' + grants.map(function (d) {
            return '<label class="rf-check"><input type="checkbox" data-grant="' + esc(d.id) + '" data-title="' + esc(d.title) + '"' +
              (linked.indexOf(d.id) !== -1 ? ' checked' : '') + '> 📑 ' + esc(d.title) +
              ' <span class="rf-mini-status">' + esc(d.status || '') + '</span></label>';
          }).join('') + '</div>'
        : '<p class="rf-empty-sm">No grant drafts found — capture a 💡 grant idea and promote it instead.</p>') +
      '<div class="rf-modal-actions"><span class="rf-modal-err" hidden></span>' +
        '<button type="button" class="rf-btn" data-act="cancel">Cancel</button>' +
        (grants.length ? '<button type="button" class="rf-btn rf-btn-primary" data-act="save">Save</button>' : '') +
      '</div>';

    m.body.addEventListener('click', async function (e) {
      var act = e.target.closest('[data-act]');
      if (!act) return;
      if (act.getAttribute('data-act') === 'cancel') { m.close(); return; }
      if (act.getAttribute('data-act') !== 'save') return;
      act.disabled = true;
      try {
        var keepIds = [];
        var refs = ((concept.links && concept.links.draft_refs) || [])
          .filter(function (r) { return r.kind !== 'grant'; });   // keep non-grant refs untouched
        m.body.querySelectorAll('[data-grant]:checked').forEach(function (cb) {
          keepIds.push(cb.getAttribute('data-grant'));
          refs.push({ id: cb.getAttribute('data-grant'), title: cb.getAttribute('data-title'), kind: 'grant' });
        });
        await RD.update(concept.id, { 'links.draft_refs': refs });
        m.close();
        toast('success', keepIds.length ? 'Grant linked.' : 'Grant links updated.');
        if (onDone) onDone();
      } catch (err) {
        var el = m.body.querySelector('.rf-modal-err'); if (el) { el.textContent = err && err.message; el.hidden = false; }
        act.disabled = false;
      }
    });
  }

  window.RESEARCH_LINKS = { openEditor: openEditor, openOutputLinker: openOutputLinker, openGrantLinker: openGrantLinker };
})();
