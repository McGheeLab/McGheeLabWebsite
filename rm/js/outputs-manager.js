/* outputs-manager.js — V3.556 (Research Foci: all-outputs manager)
 *
 * One admin view of every output the lab has — papers, grants, and patents
 * — with type, created date, an at-a-glance activity report (status, last
 * touched, authors, which research foci it feeds), and a **site-wide
 * delete** that removes a paper/grant everywhere via the existing
 * `deleteBuilderPaper` Admin-SDK Cloud Function (paper doc, figures,
 * comments, reader highlights, library links) — the same cascade the paper
 * builder uses. Patents live only on research-foci cards, so deleting one
 * just removes it from its card.
 *
 * Sources: `projects/papers.json` (papers + grants, discriminated by
 * paper_type) enriched from each `papers/{id}` content doc for dates, and
 * `researchFoci` output cards for patents + the draft→foci back-map.
 */
(function () {
  'use strict';

  var RD = window.RESEARCH_DATA;
  var esc = RD ? RD.esc : function (s) { return String(s == null ? '' : s); };
  var DELETE_FN_URL = 'https://us-central1-mcgheelab-f56cc.cloudfunctions.net/deleteBuilderPaper';

  var root, state = { rows: [], isAdmin: false, deleteReady: false };

  function toast(kind, msg) { if (window.TOAST && TOAST[kind]) TOAST[kind](msg); }
  function fmtDate(v) {
    if (!v) return '—';
    var s = String(v);
    // ISO or Firestore Timestamp-ish → YYYY-MM-DD
    var m = s.match(/^(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : s.slice(0, 10);
  }

  var TYPE_LABEL = {
    journal: 'Paper', paper: 'Paper', grant: 'Grant', editorial: 'Editorial',
    'book-chapter': 'Chapter', patent: 'Patent', presentation: 'Presentation',
  };
  function typeOf(p) { return TYPE_LABEL[p.paper_type] || TYPE_LABEL[p.kind] || 'Paper'; }

  // V3.561 — admin re-categorization. A record's category is its
  // paper_type on the projects/papers.json row; a mis-filed grant (created
  // as a paper) is fixed here with one select. Grant vs output matters:
  // grants live within concepts; outputs are papers/presentations/patents.
  var TYPE_CHOICES = [
    ['grant', 'Grant'], ['journal', 'Paper'], ['presentation', 'Presentation'],
    ['patent', 'Patent'], ['editorial', 'Editorial'], ['book-chapter', 'Chapter'],
  ];

  async function setPaperType(id, newType) {
    var data = await api.load('projects/papers.json');
    var arr = (data && data.papers) || [];
    var row = arr.filter(function (p) { return p.id === id; })[0];
    if (!row) throw new Error('Record not found.');
    row.paper_type = newType;
    if (newType !== 'grant') row.grant_subtype = null;
    await api.save('projects/papers.json', { papers: arr });
    try { if (window.LIBRARY_ASSOC && LIBRARY_ASSOC.invalidate) LIBRARY_ASSOC.invalidate(); } catch (e) {}
  }

  async function probeDelete() {
    try {
      var r = await fetch(DELETE_FN_URL, { method: 'GET' });
      var j = r.ok ? await r.json() : null;
      state.deleteReady = !!(j && j.ok);
    } catch (e) { state.deleteReady = false; }
  }

  async function load() {
    // 1) papers + grants from the builder's source of truth. Force-fresh:
    // deletions run in the deleteBuilderPaper Cloud Function (outside
    // api.save) and bump no updatedAt, so the adapter's stale-while-
    // revalidate freshness probe would otherwise keep serving a list that
    // still contains the deleted paper. Invalidating first guarantees the
    // next load reflects real Firestore state.
    var papers = [];
    try { if (window.api && api.invalidate) await api.invalidate('projects/papers.json'); } catch (e) {}
    try { if (window.LIBRARY_ASSOC && LIBRARY_ASSOC.invalidate) LIBRARY_ASSOC.invalidate(); } catch (e) {}
    try { var data = await api.load('projects/papers.json'); papers = (data && data.papers) || []; } catch (e) {}

    // 2) research foci → back-map draft_id → [foci], + patents
    var foci = [];
    try { foci = await RD.listAll(); } catch (e) {}
    var draftToFoci = {};
    var patentRows = [];
    foci.forEach(function (f) {
      ((f.links && f.links.draft_refs) || []).forEach(function (r) {
        (draftToFoci[r.id] = draftToFoci[r.id] || []).push(f);
      });
      if (f.level === 'output') {
        ((f.links && f.links.patents) || []).forEach(function (pt) {
          patentRows.push({
            id: pt.id, title: pt.title || pt.number || 'Patent', paper_type: 'patent',
            status: pt.status || '', _patent: true, _fociId: f.id, _fociTitle: f.title,
            created_at: null, updated_at: null, foci: [f],
          });
        });
      }
    });

    // 3) enrich each paper/grant from its content doc (dates + author count)
    var enriched = await Promise.all(papers.map(async function (p) {
      var row = {
        id: p.id, title: p.title || p.id, paper_type: p.paper_type || 'journal',
        status: p.status || 'drafting', lead_author: p.lead_author || '',
        authorCount: 1 + ((p.coauthor_uids || []).length),
        created_at: p.created_at || null, updated_at: p.updated_at || null,
        foci: draftToFoci[p.id] || [],
      };
      try {
        var doc = await firebridge.db().collection('papers').doc(p.id).get();
        if (doc.exists) {
          var d = doc.data() || {};
          row.created_at = row.created_at || d.created_at || null;
          row.updated_at = d.updated_at || d.updatedAt || row.updated_at;
          if (Array.isArray(d.authorUids) && d.authorUids.length) row.authorCount = d.authorUids.length;
        }
      } catch (e) {}
      return row;
    }));

    state.rows = enriched.concat(patentRows).sort(function (a, b) {
      return (b.updated_at || b.created_at || '').localeCompare(a.updated_at || a.created_at || '') ||
             (a.title || '').localeCompare(b.title || '');
    });
  }

  function activityCell(r) {
    var st = RD.STATUS_META && RD.STATUS_META[r.status];
    var pill = st
      ? '<span class="rf-status" style="color:' + st.color + ';background:' + st.bg + '">' + esc(st.label) + '</span>'
      : (r.status ? '<span class="rf-status">' + esc(r.status) + '</span>' : '');
    var bits = [];
    if (r.updated_at) bits.push('updated ' + fmtDate(r.updated_at));
    if (r.authorCount) bits.push(r.authorCount + ' author' + (r.authorCount === 1 ? '' : 's'));
    var foci = (r.foci || []).map(function (f) {
      return '<a class="rf-combine-pill" href="/rm/pages/research.html?id=' + encodeURIComponent(f.id) + '">🎯 ' + esc(f.title) + '</a>';
    }).join('');
    return pill + (bits.length ? ' <span class="om-sub">' + esc(bits.join(' · ')) + '</span>' : '') +
      (foci ? '<div class="om-foci">' + foci + '</div>' : '');
  }

  function render() {
    if (!root) return;
    if (!state.rows.length) {
      root.innerHTML = '<p class="rf-empty-sm">No papers, grants, or patents yet.</p>';
      return;
    }
    var canDel = state.isAdmin;
    var rows = state.rows.map(function (r) {
      var open = r._patent
        ? '<a href="/rm/pages/research.html?id=' + encodeURIComponent(r._fociId) + '">' + esc(r.title) + '</a>'
        : '<a href="/rm/pages/paper-builder.html?paper=' + encodeURIComponent(r.id) + '">' + esc(r.title) + '</a>';
      var delBtn = '';
      if (canDel) {
        if (r._patent) {
          delBtn = '<button class="rf-btn rf-btn-danger rf-btn-sm" data-del-patent="' + esc(r.id) + '" data-foci="' + esc(r._fociId) + '">🗑</button>';
        } else if (state.deleteReady) {
          delBtn = '<button class="rf-btn rf-btn-danger rf-btn-sm" data-del="' + esc(r.id) + '" data-title="' + esc(r.title) + '">🗑</button>';
        } else {
          delBtn = '<span class="om-sub" title="deleteBuilderPaper function not deployed">—</span>';
        }
      }
      // Admin: category is editable in place (patents authored on cards are
      // not papers.json rows — their type is fixed).
      var typeCell;
      if (canDel && !r._patent) {
        typeCell = '<select class="om-type-sel" data-retype="' + esc(r.id) + '">' +
          TYPE_CHOICES.map(function (t) {
            return '<option value="' + t[0] + '"' + ((r.paper_type || 'journal') === t[0] ? ' selected' : '') + '>' + t[1] + '</option>';
          }).join('') + '</select>';
      } else {
        typeCell = '<span class="om-type om-type-' + esc(r.paper_type) + '">' + esc(typeOf(r)) + '</span>';
      }
      return '<tr>' +
        '<td class="om-title">' + open + '</td>' +
        '<td>' + typeCell + '</td>' +
        '<td>' + esc(fmtDate(r.created_at)) + '</td>' +
        '<td class="om-activity">' + activityCell(r) + '</td>' +
        (canDel ? '<td class="om-del">' + delBtn + '</td>' : '') +
      '</tr>';
    }).join('');

    root.innerHTML =
      '<div class="om-wrap">' +
        '<p class="rf-hub-intro">Every paper, grant, and patent the lab is building — with its type, when it was created, and a quick activity report. ' +
          (canDel ? 'The 🗑 deletes a paper or grant <strong>everywhere in RM</strong> (its content, figures, comments, reader highlights, and library links) — this cannot be undone.' : '') +
        '</p>' +
        '<div class="om-scroll"><table class="om-table"><thead><tr>' +
          '<th>Title</th><th>Type</th><th>Created</th><th>Activity</th>' + (canDel ? '<th></th>' : '') +
        '</tr></thead><tbody>' + rows + '</tbody></table></div>' +
      '</div>';
  }

  async function onClick(e) {
    var del = e.target.closest('[data-del]');
    if (del) { await deleteOutput(del.getAttribute('data-del'), del.getAttribute('data-title')); return; }
    var dp = e.target.closest('[data-del-patent]');
    if (dp) { await deletePatent(dp.getAttribute('data-foci'), dp.getAttribute('data-del-patent')); return; }
  }

  async function onChange(e) {
    var sel = e.target.closest('[data-retype]');
    if (!sel) return;
    var id = sel.getAttribute('data-retype');
    var newType = sel.value;
    sel.disabled = true;
    try {
      await setPaperType(id, newType);
      // Re-filed as a grant → its research-map card (if any) no longer
      // belongs on the outputs band. Offer to remove it (record untouched);
      // the grant then links on a concept's Grant section.
      if (newType === 'grant') {
        try {
          var foci = await RD.listAll();
          var card = foci.filter(function (f) { return f.source_draft_id === id; })[0];
          if (card && confirm('Re-filed as a Grant. Grants live within concepts — remove its output card from the research map? (The grant itself is untouched; link it on a concept\'s Grant section.)')) {
            await RD.remove(card.id);
          }
        } catch (err) { /* non-fatal */ }
      }
      toast('success', 'Category updated.');
      await reload();
    } catch (err) {
      toast('error', 'Category change failed: ' + (err && err.message));
      sel.disabled = false;
    }
  }

  async function deleteOutput(id, title) {
    if (!window.confirm('Delete "' + title + '" from the ENTIRE RM site?\n\n' +
      'This permanently removes the paper/grant, its figures, comments, reader ' +
      'highlights, and library links, and unlinks it from any research foci. ' +
      'This cannot be undone.')) return;
    var me = (firebase.auth && firebase.auth().currentUser) || null;
    if (!me) { toast('error', 'Sign in to delete.'); return; }
    toast('info', 'Deleting "' + title + '"…');
    try {
      var idToken = await me.getIdToken();
      var r = await fetch(DELETE_FN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + idToken },
        body: JSON.stringify({ paperId: id }),
      });
      var j = await r.json().catch(function () { return {}; });
      if (!r.ok || !j.ok) throw new Error(j.error || ('HTTP ' + r.status));
      try { if (window.api && api.invalidate) await api.invalidate('projects/papers.json'); } catch (e) {}
      // Also scrub the id from any research-foci draft_refs so no dangling pill.
      await scrubFociRefs(id);
      toast('success', 'Deleted "' + title + '" site-wide.');
      await reload();
    } catch (e) { toast('error', 'Delete failed: ' + (e.message || e)); }
  }

  // After a site-wide paper/grant delete: remove the id from every card's
  // draft_refs, and DELETE any draft-backed output card whose whole
  // identity was that record (source_draft_id — V3.557).
  async function scrubFociRefs(draftId) {
    try {
      var foci = await RD.listAll();
      var jobs = [];
      foci.forEach(function (f) {
        if (f.source_draft_id === draftId) { jobs.push(RD.remove(f.id)); return; }
        var refs = (f.links && f.links.draft_refs) || [];
        if (refs.some(function (r) { return r.id === draftId; })) {
          var next = refs.filter(function (r) { return r.id !== draftId; });
          jobs.push(RD.update(f.id, { 'links.draft_refs': next }));
        }
      });
      await Promise.all(jobs);
    } catch (e) { /* non-fatal */ }
  }

  async function deletePatent(fociId, patentId) {
    if (!window.confirm('Remove this patent from its research card?')) return;
    try {
      var f = await RD.get(fociId);
      if (!f) return;
      var next = ((f.links && f.links.patents) || []).filter(function (p) { return p.id !== patentId; });
      await RD.update(fociId, { 'links.patents': next });
      toast('success', 'Patent removed.');
      await reload();
    } catch (e) { toast('error', 'Remove failed: ' + (e.message || e)); }
  }

  async function reload() { await load(); render(); }

  async function init() {
    root = document.getElementById('outputs-root');
    if (!root || typeof firebridge === 'undefined' || !window.RESEARCH_DATA) return;
    if (firebridge.requireSignIn) await firebridge.requireSignIn();
    if (!firebridge.getUser()) return;
    if (firebridge.isLabMember && !firebridge.isLabMember()) {
      root.innerHTML = '<div class="rf-band-empty">The outputs list is for lab members.</div>';
      return;
    }
    state.isAdmin = !!(firebridge.isAdmin && firebridge.isAdmin());
    root.addEventListener('click', onClick);
    root.addEventListener('change', onChange);
    await Promise.all([load(), probeDelete()]);
    render();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
