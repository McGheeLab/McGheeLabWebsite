/* roadmap-attach.js — V3.601 (Research Roadmap program R2)
 *
 * "This paper matters to that experiment, and here is why."
 *
 * The cross-page surface for attaching a library paper to a research
 * roadmap item. One modal, reachable from three places:
 *
 *   library.html        🗺 on any row
 *   library-paper.html  the reader sidebar's Roadmaps block
 *   research.html       ＋ Paper on any roadmap item
 *
 * The modal lists every output card that has a roadmap, expanded into its
 * targets (the whole roadmap / an experiment / an analysis). Checking a
 * target reveals a relevance select and — the entire reason this feature
 * exists — a **note** field: why is this paper appropriate HERE. The note
 * is per-attachment, not per-paper, because the same paper is often
 * relevant to two analyses for completely different reasons.
 *
 * Saving diffs desired targets against what the paper is already attached
 * to, so the modal doubles as the detach surface.
 *
 * Reuses the reader's existing picker CSS (.lp-overlay-import-modal /
 * .lp-oim-* / .lp-linkpick-*) rather than inventing a third modal look.
 *
 * Data: window.ROADMAP_DATA. Globals: window.ROADMAP_ATTACH
 */
(function () {
  'use strict';

  var RM = window.ROADMAP_DATA;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function toast(kind, msg) {
    if (window.TOAST && TOAST[kind]) TOAST[kind](msg);
    else if (kind === 'error') alert(msg);
  }

  /* Title / authors / year copied onto the ref so a roadmap renders its
   * paper pills without loading the library. A snapshot, deliberately:
   * the roadmap wants the citation as it was understood when someone
   * decided the paper belonged there. */
  function snapshotOf(item) {
    var lib = (item && item.meta && item.meta.library) || {};
    var authors = Array.isArray(lib.authors) ? lib.authors : [];
    var names = authors.slice(0, 3).map(function (a) {
      return (a && (a.family || a.given)) ? (a.family || a.given) : String(a || '');
    }).filter(Boolean);
    if (authors.length > 3) names.push('et al.');
    return {
      title: item.title || lib.title || item.id,
      authors: names.join(', '),
      year: lib.year || '',
    };
  }

  function targetKey(t) { return t.id || 'root'; }

  /* ── the modal ──────────────────────────────────────────────── */

  /** open({ item, presetFociId, presetTarget, onDone })
   *  item          the library item (needs .id, .title, .meta.library)
   *  presetFociId  scroll to + expand this card (from research.html)
   *  presetTarget  {kind, id} pre-checked (the ＋ Paper button's target)
   *  onDone(refs)  called after a successful save */
  async function open(opts) {
    opts = opts || {};
    var item = opts.item;
    if (!item || !item.id) { toast('error', 'No paper to attach.'); return; }
    if (!RM) { toast('error', 'Roadmap module not loaded.'); return; }

    var old = document.getElementById('rmap-attach-modal');
    if (old) old.remove();

    var modal = document.createElement('div');
    modal.id = 'rmap-attach-modal';
    modal.className = 'lp-overlay-import-modal';
    modal.innerHTML =
      '<div class="lp-oim-backdrop"></div>' +
      '<div class="lp-oim-card">' +
        '<div class="lp-oim-head">Add this paper to a roadmap</div>' +
        '<div class="lp-oim-summary">Loading roadmaps…</div>' +
      '</div>';
    document.body.appendChild(modal);
    var card = modal.querySelector('.lp-oim-card');
    function close() { modal.remove(); }
    modal.querySelector('.lp-oim-backdrop').addEventListener('click', close);

    var cards, existing;
    try {
      cards = await RM.listRoadmapCards({ withRoadmapOnly: true });
      existing = await RM.listRefsForItem(item);
    } catch (e) {
      card.innerHTML = '<div class="lp-oim-head">Add this paper to a roadmap</div>' +
        '<div class="lp-oim-summary">Could not load roadmaps: ' + esc(e && e.message) + '</div>' +
        '<div class="lp-oim-foot"><button class="btn btn-sm" data-x>Close</button></div>';
      card.querySelector('[data-x]').addEventListener('click', close);
      return;
    }

    if (!cards.length) {
      card.innerHTML = '<div class="lp-oim-head">Add this paper to a roadmap</div>' +
        '<div class="lp-oim-summary">No output card has a roadmap yet. The PI lays one out on ' +
        '<a href="/rm/pages/research.html">the research map</a> — experiments, the analyses each yields, ' +
        'and the figure each analysis becomes — and then papers can attach to any of it.</div>' +
        '<div class="lp-oim-foot"><button class="btn btn-sm" data-x>Close</button></div>';
      card.querySelector('[data-x]').addEventListener('click', close);
      return;
    }

    // Existing attachments, keyed fociId::targetKey, so the modal opens
    // showing the truth and doubles as the detach surface.
    var have = {};
    existing.forEach(function (r) {
      have[r.foci_id + '::' + targetKey(r.target || {})] = r;
    });

    function rowHtml(fociId, t, idx) {
      var key = fociId + '::' + targetKey(t);
      var pre = have[key];
      var preset = opts.presetFociId === fociId && opts.presetTarget &&
        (opts.presetTarget.id || null) === (t.id || null);
      var checked = !!pre || !!preset;
      var label = t.kind === 'roadmap'
        ? '<em>' + esc(t.label) + '</em>'
        : (t.kind === 'experiment' ? '<strong>' + esc(t.label) + '</strong>' : esc(t.label));
      var rel = pre ? pre.relevance : 2;
      var note = pre ? pre.note : '';
      return '<div class="rmap-at-row rmap-at-d' + t.depth + '" data-key="' + esc(key) + '" ' +
             'data-row-search="' + esc((t.label + ' ' + (t.experiment_title || '')).toLowerCase()) + '">' +
        '<label class="rmap-at-check">' +
          '<input type="checkbox" data-foci="' + esc(fociId) + '" data-kind="' + esc(t.kind) + '"' +
            (t.id ? ' data-target="' + esc(t.id) + '"' : '') + (checked ? ' checked' : '') + '>' +
          '<span class="rmap-at-label">' + label + '</span>' +
          (pre ? '<span class="rmap-at-have">attached</span>' : '') +
        '</label>' +
        '<div class="rmap-at-why"' + (checked ? '' : ' hidden') + '>' +
          '<select class="rmap-at-rel">' +
            [3, 2, 1].map(function (w) {
              return '<option value="' + w + '"' + (w === rel ? ' selected' : '') + '>' + esc(RM.RELEVANCE[w]) + '</option>';
            }).join('') + '</select>' +
          '<input type="text" class="rmap-at-note" placeholder="Why is this paper appropriate here?" value="' + esc(note) + '">' +
        '</div>' +
      '</div>';
    }

    var listHtml = cards.map(function (c) {
      var targets = RM.attachTargets(c.roadmap);
      var mine = targets.filter(function (t) { return have[c.id + '::' + targetKey(t)]; }).length;
      return '<div class="lp-linkpick-group rmap-at-group" data-foci="' + esc(c.id) + '">' +
        '<div class="lp-linkpick-group-head">' + ICON.render(c.icon) + ' ' + esc(c.title) +
          (mine ? '<span class="lp-linkpick-group-count">' + mine + '</span>' : '') +
        '</div>' +
        targets.map(function (t, i) { return rowHtml(c.id, t, i); }).join('') +
      '</div>';
    }).join('');

    var snap = snapshotOf(item);
    card.innerHTML =
      '<div class="lp-oim-head">Add “' + esc(snap.title) + '” to a roadmap</div>' +
      '<div class="lp-oim-summary">Tick every experiment or analysis this paper speaks to, and say why. ' +
        'The note is what a labmate reads on the roadmap — “methods we’re copying for the void-fraction ' +
        'measurement” beats “relevant”. Unticking an attached item detaches it.</div>' +
      '<div class="lp-linkpick-search-wrap"><input id="rmap-at-search" type="text" placeholder="Search experiments and analyses…" autocomplete="off"></div>' +
      '<div class="lp-linkpick-list rmap-at-list">' + listHtml + '</div>' +
      '<div class="lp-oim-foot">' +
        '<span class="rmap-at-err"></span>' +
        '<button class="btn btn-sm" data-x>Cancel</button>' +
        '<button class="btn btn-sm lp-oim-primary" data-save>Save</button>' +
      '</div>';
    card.querySelector('[data-x]').addEventListener('click', close);

    // Checking a target reveals its own relevance + note. Per-attachment,
    // not per-paper: the same paper is often relevant to two analyses for
    // entirely different reasons.
    card.addEventListener('change', function (e) {
      var cb = e.target.closest('input[type=checkbox][data-foci]');
      if (!cb) return;
      var why = cb.closest('.rmap-at-row').querySelector('.rmap-at-why');
      why.hidden = !cb.checked;
      if (cb.checked) { var n = why.querySelector('.rmap-at-note'); if (n) n.focus(); }
    });

    var search = card.querySelector('#rmap-at-search');
    search.addEventListener('input', function () {
      var tokens = search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
      card.querySelectorAll('.rmap-at-group').forEach(function (g) {
        var shown = 0;
        g.querySelectorAll('.rmap-at-row').forEach(function (row) {
          var hay = row.getAttribute('data-row-search') || '';
          // The "whole roadmap" row has no text of its own — keep it
          // visible whenever anything in its card matches, so a filtered
          // card can still take a card-level attachment.
          var isRoot = row.classList.contains('rmap-at-d0');
          var show = !tokens.length || isRoot || tokens.every(function (t) { return hay.indexOf(t) !== -1; });
          row.hidden = !show;
          if (show && !isRoot) shown++;
        });
        g.hidden = !!tokens.length && !shown;
      });
    });
    if (opts.presetFociId) {
      var g = card.querySelector('.rmap-at-group[data-foci="' + CSS.escape(opts.presetFociId) + '"]');
      if (g) g.scrollIntoView({ block: 'center' });
    }
    setTimeout(function () { search.focus(); }, 0);

    card.querySelector('[data-save]').addEventListener('click', async function (ev) {
      var btn = ev.currentTarget;
      var errEl = card.querySelector('.rmap-at-err');
      btn.disabled = true; btn.textContent = 'Saving…';
      errEl.textContent = '';
      try {
        var desired = {};
        card.querySelectorAll('input[type=checkbox][data-foci]').forEach(function (cb) {
          if (!cb.checked) return;
          var row = cb.closest('.rmap-at-row');
          var fociId = cb.getAttribute('data-foci');
          var tid = cb.getAttribute('data-target') || null;
          desired[fociId + '::' + (tid || 'root')] = {
            fociId: fociId,
            target: { kind: cb.getAttribute('data-kind'), id: tid },
            relevance: parseInt(row.querySelector('.rmap-at-rel').value, 10) || 2,
            note: row.querySelector('.rmap-at-note').value,
          };
        });

        var added = 0, removed = 0;
        for (var key in desired) {
          var d = desired[key];
          await RM.addRef(d.fociId, {
            itemId: item.id, target: d.target, note: d.note,
            relevance: d.relevance, snapshot: snap,
          });
          added++;
        }
        for (var k2 in have) {
          if (desired[k2]) continue;
          var r = have[k2];
          await RM.removeRef(r.foci_id, r.id, item.id);
          removed++;
        }

        // Keep the caller's in-memory item honest — the reverse index was
        // just rewritten and the sidebar re-renders off it.
        try {
          var fresh = await RM.listRefsForItem(item);
          var ids = [];
          fresh.forEach(function (r2) { if (ids.indexOf(r2.foci_id) === -1) ids.push(r2.foci_id); });
          item.meta = item.meta || {};
          item.meta.library = item.meta.library || {};
          item.meta.library.roadmaps = ids;
          close();
          if (opts.onDone) await opts.onDone(fresh);
        } catch (e) { close(); if (opts.onDone) await opts.onDone(null); }

        toast('success', added
          ? ('Attached to ' + added + ' roadmap item' + (added === 1 ? '' : 's') + (removed ? ', ' + removed + ' detached' : ''))
          : (removed ? 'Detached from ' + removed + ' item' + (removed === 1 ? '' : 's') : 'Nothing changed'));
      } catch (e) {
        btn.disabled = false; btn.textContent = 'Save';
        errEl.textContent = 'Save failed: ' + (e && e.message);
      }
    });
  }

  /* ── the reverse direction: from a roadmap item, pick a paper ── */

  /** openForTarget({ fociId, target, targetLabel, onDone })
   *  Called from research.html's ＋ Paper buttons, where the target is
   *  already known and the missing half is the paper. A search list over
   *  the library, single-select, plus the same relevance + note fields —
   *  the note is required in spirit, so it's the focused field. */
  async function openForTarget(opts) {
    opts = opts || {};
    if (!opts.fociId) return;
    var old = document.getElementById('rmap-attach-modal');
    if (old) old.remove();

    var modal = document.createElement('div');
    modal.id = 'rmap-attach-modal';
    modal.className = 'lp-overlay-import-modal';
    modal.innerHTML =
      '<div class="lp-oim-backdrop"></div>' +
      '<div class="lp-oim-card">' +
        '<div class="lp-oim-head">Add a reference paper</div>' +
        '<div class="lp-oim-summary">Loading the library…</div>' +
      '</div>';
    document.body.appendChild(modal);
    var card = modal.querySelector('.lp-oim-card');
    function close() { modal.remove(); }
    modal.querySelector('.lp-oim-backdrop').addEventListener('click', close);

    var papers = [];
    try {
      var data = await api.load('library/papers.json');
      papers = ((data && data.papers) || []).filter(function (p) {
        var lib = (p.meta && p.meta.library) || {};
        return lib.is_library_entry !== false;
      });
    } catch (e) {
      card.innerHTML = '<div class="lp-oim-head">Add a reference paper</div>' +
        '<div class="lp-oim-summary">Could not load the library: ' + esc(e && e.message) + '</div>' +
        '<div class="lp-oim-foot"><button class="btn btn-sm" data-x>Close</button></div>';
      card.querySelector('[data-x]').addEventListener('click', close);
      return;
    }
    papers.sort(function (a, b) {
      var la = (a.meta && a.meta.library) || {}, lb = (b.meta && b.meta.library) || {};
      return String(lb.date_added || '').localeCompare(String(la.date_added || '')) ||
             String(a.title || '').localeCompare(String(b.title || ''));
    });

    // A whole library is thousands of rows; render the newest slice and
    // let search reach the rest rather than freezing the page on open.
    var PAGE = 60;
    function rowsHtml(list) {
      return list.map(function (p) {
        var snap = snapshotOf(p);
        return '<label class="lp-linkpick-row rmap-at-prow" data-row-search="' +
            esc(((snap.title || '') + ' ' + (snap.authors || '') + ' ' + (snap.year || '')).toLowerCase()) + '">' +
          '<input type="radio" name="rmap-at-paper" value="' + esc(p.id) + '">' +
          '<span class="lp-linkpick-titlewrap">' +
            '<span class="lp-linkpick-title">' + esc(snap.title) + '</span>' +
            '<span class="lp-linkpick-hint">' + esc(snap.authors) + (snap.year ? ' · ' + esc(snap.year) : '') + '</span>' +
          '</span>' +
        '</label>';
      }).join('');
    }

    card.innerHTML =
      '<div class="lp-oim-head">Add a reference paper</div>' +
      '<div class="lp-oim-summary">Attaching to <strong>' + esc(opts.targetLabel || 'this roadmap') + '</strong>. ' +
        'Pick the paper, then say why it belongs here — that note is what the next person reads.</div>' +
      '<div class="lp-linkpick-search-wrap"><input id="rmap-at-psearch" type="text" placeholder="Search the library by title, author, year…" autocomplete="off"></div>' +
      '<div class="lp-linkpick-list rmap-at-plist">' + rowsHtml(papers.slice(0, PAGE)) +
        (papers.length > PAGE ? '<div class="rmap-at-more">Showing the ' + PAGE + ' most recent of ' + papers.length + ' — search to reach the rest.</div>' : '') +
      '</div>' +
      '<div class="rmap-at-why rmap-at-why-fixed">' +
        '<select class="rmap-at-rel">' +
          [3, 2, 1].map(function (w) {
            return '<option value="' + w + '"' + (w === 2 ? ' selected' : '') + '>' + esc(RM.RELEVANCE[w]) + '</option>';
          }).join('') + '</select>' +
        '<input type="text" class="rmap-at-note" placeholder="Why is this paper appropriate here?">' +
      '</div>' +
      '<div class="lp-oim-foot">' +
        '<span class="rmap-at-err"></span>' +
        '<button class="btn btn-sm" data-x>Cancel</button>' +
        '<button class="btn btn-sm lp-oim-primary" data-save>Attach</button>' +
      '</div>';
    card.querySelector('[data-x]').addEventListener('click', close);

    var byId = {};
    papers.forEach(function (p) { byId[p.id] = p; });
    var list = card.querySelector('.rmap-at-plist');
    var search = card.querySelector('#rmap-at-psearch');
    search.addEventListener('input', function () {
      var q = search.value.trim().toLowerCase();
      var tokens = q.split(/\s+/).filter(Boolean);
      if (!tokens.length) { list.innerHTML = rowsHtml(papers.slice(0, PAGE)); return; }
      var hits = papers.filter(function (p) {
        var snap = snapshotOf(p);
        var hay = ((snap.title || '') + ' ' + (snap.authors || '') + ' ' + (snap.year || '')).toLowerCase();
        return tokens.every(function (t) { return hay.indexOf(t) !== -1; });
      });
      list.innerHTML = hits.length
        ? rowsHtml(hits.slice(0, 200))
        : '<div class="lp-linkpick-empty">No paper matches that.</div>';
    });
    setTimeout(function () { search.focus(); }, 0);

    card.querySelector('[data-save]').addEventListener('click', async function (ev) {
      var btn = ev.currentTarget;
      var errEl = card.querySelector('.rmap-at-err');
      var picked = card.querySelector('input[name=rmap-at-paper]:checked');
      if (!picked) { errEl.textContent = 'Pick a paper first.'; return; }
      var item = byId[picked.value];
      btn.disabled = true; btn.textContent = 'Attaching…';
      errEl.textContent = '';
      try {
        await RM.addRef(opts.fociId, {
          itemId: item.id,
          target: opts.target || { kind: 'roadmap', id: null },
          note: card.querySelector('.rmap-at-note').value,
          relevance: parseInt(card.querySelector('.rmap-at-rel').value, 10) || 2,
          snapshot: snapshotOf(item),
        });
        close();
        toast('success', 'Paper attached.');
        if (opts.onDone) await opts.onDone();
      } catch (e) {
        btn.disabled = false; btn.textContent = 'Attach';
        errEl.textContent = 'Attach failed: ' + (e && e.message);
      }
    });
  }

  /** Edit just the note + relevance of an existing ref, in place. */
  function openNoteEditor(fociId, ref, onDone) {
    var old = document.getElementById('rmap-attach-modal');
    if (old) old.remove();
    var modal = document.createElement('div');
    modal.id = 'rmap-attach-modal';
    modal.className = 'lp-overlay-import-modal';
    modal.innerHTML =
      '<div class="lp-oim-backdrop"></div>' +
      '<div class="lp-oim-card">' +
        '<div class="lp-oim-head">Why this paper?</div>' +
        '<div class="lp-oim-summary">' + esc(ref.title_snapshot || ref.item_id) + '</div>' +
        '<div class="rmap-at-why rmap-at-why-fixed">' +
          '<select class="rmap-at-rel">' +
            [3, 2, 1].map(function (w) {
              return '<option value="' + w + '"' + (w === ref.relevance ? ' selected' : '') + '>' + esc(RM.RELEVANCE[w]) + '</option>';
            }).join('') + '</select>' +
          '<input type="text" class="rmap-at-note" value="' + esc(ref.note || '') + '" placeholder="Why is this paper appropriate here?">' +
        '</div>' +
        '<div class="lp-oim-foot">' +
          '<span class="rmap-at-err"></span>' +
          '<button class="btn btn-sm" data-x>Cancel</button>' +
          '<button class="btn btn-sm lp-oim-primary" data-save>Save</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(modal);
    var card = modal.querySelector('.lp-oim-card');
    function close() { modal.remove(); }
    modal.querySelector('.lp-oim-backdrop').addEventListener('click', close);
    card.querySelector('[data-x]').addEventListener('click', close);
    setTimeout(function () { card.querySelector('.rmap-at-note').focus(); }, 0);
    card.querySelector('[data-save]').addEventListener('click', async function (ev) {
      var btn = ev.currentTarget;
      btn.disabled = true; btn.textContent = 'Saving…';
      try {
        await RM.updateRef(fociId, ref.id, {
          note: card.querySelector('.rmap-at-note').value,
          relevance: parseInt(card.querySelector('.rmap-at-rel').value, 10) || 2,
        });
        close();
        if (onDone) await onDone();
      } catch (e) {
        btn.disabled = false; btn.textContent = 'Save';
        card.querySelector('.rmap-at-err').textContent = 'Save failed: ' + (e && e.message);
      }
    });
  }

  /* ── the reader / library chip strip ────────────────────────── */

  /** Paint "this paper is on these roadmaps" chips into `host`. Each chip
   * deep-links to the exact analysis it was attached to, and carries the
   * note as its tooltip. Async — reads the paper's refs. */
  async function renderPaperChips(host, item, opts) {
    opts = opts || {};
    if (!host || !item) return;
    var refs = [];
    try { refs = await RM.listRefsForItem(item); } catch (e) { /* fall through to empty */ }
    if (!refs.length) {
      host.innerHTML = '<span class="rmap-chip-empty">Not on any roadmap yet.</span>';
      if (opts.onCount) opts.onCount(0);
      return;
    }
    var titles = {};
    try {
      (await RM.listRoadmapCards()).forEach(function (c) { titles[c.id] = c; });
    } catch (e) {}

    host.innerHTML = refs.map(function (r) {
      var c = titles[r.foci_id];
      var anchor = (r.target && r.target.id) ? '#rmap-' + r.target.id : '';
      var where = '';
      if (c && r.target && r.target.id) {
        RM.attachTargets(c.roadmap).forEach(function (t) {
          if (t.id === r.target.id) where = t.label;
        });
      }
      return '<a class="rmap-chip" href="/rm/pages/research.html?id=' + encodeURIComponent(r.foci_id) + anchor + '" ' +
        'title="' + esc(r.note || 'No note') + '">' +
        '<span class="rmap-chip-card">' + ICON.svg('map') + ' ' + esc(c ? c.title : r.foci_id) + '</span>' +
        (where ? '<span class="rmap-chip-where">' + esc(where) + '</span>' : '') +
      '</a>';
    }).join('');
    if (opts.onCount) opts.onCount(refs.length);
  }

  window.ROADMAP_ATTACH = {
    open: open,
    openForTarget: openForTarget,
    openNoteEditor: openNoteEditor,
    renderPaperChips: renderPaperChips,
    snapshotOf: snapshotOf,
  };
})();
