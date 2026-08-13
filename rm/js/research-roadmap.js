/* research-roadmap.js — V3.600 (Research Roadmap program R1)
 *
 * The Roadmap section on an OUTPUT card's detail view
 * (rm/pages/research.html?id=<fociId>) plus the admin editor behind it.
 *
 * A roadmap answers the question the research map never could: what has
 * to actually HAPPEN for this paper to exist. It reads top-down —
 *
 *   experiment  →  analyses  →  the figure each analysis becomes
 *
 * so a student looking at "GELS paper" can see that it needs confocal
 * time-point measurements, that those yield five separate measurements,
 * and that "void space over time" is destined to be Fig 2b. Reference
 * papers attach at any level with a note saying why they're appropriate
 * (roadmap-attach.js, R2).
 *
 * Data + vocabulary: window.ROADMAP_DATA (standalone, no RESEARCH_DATA
 * dependency). Modal shell + sanitizer: RESEARCH_DATA. Rich text toolbar:
 * RESEARCH_COMPOSER.richToolbar/wireRich.
 *
 * Globals: window.RESEARCH_ROADMAP
 */
(function () {
  'use strict';

  var RM = window.ROADMAP_DATA;
  var RD = window.RESEARCH_DATA;
  var esc = RM ? RM.esc : function (s) { return String(s == null ? '' : s); };

  function sanitize(html) { return RD && RD.sanitizeHtml ? RD.sanitizeHtml(html) : ''; }

  /* ── shared bits ────────────────────────────────────────────── */

  function statusPill(status) {
    var m = RM.STATUS_META[status] || RM.STATUS_META.planned;
    return '<span class="rf-status rmap-status" style="color:' + m.color + ';background:' + m.bg + '">' +
      esc(m.label) + '</span>';
  }

  function figureChip(fig) {
    if (!fig || !fig.needed) return '';
    var kind = RM.FIGURE_KINDS[fig.kind] || RM.FIGURE_KINDS.figure;
    var st = RM.FIGURE_STATUS[fig.status] || RM.FIGURE_STATUS.none;
    var label = fig.figure_ref ? fig.figure_ref : kind.label;
    return '<span class="rmap-fig" title="' + esc(kind.label) + ' — ' + esc(st.label) + '">' +
      '<span class="rmap-fig-kind">' + kind.icon + ' ' + esc(label) + '</span>' +
      (fig.caption_target ? '<span class="rmap-fig-cap">' + esc(fig.caption_target) + '</span>' : '') +
      '<span class="rmap-fig-st" style="color:' + st.color + ';background:' + st.bg + '">' + esc(st.label) + '</span>' +
    '</span>';
  }

  /* Reference-paper pills. The NOTE is the payload — it renders inline,
   * not behind a tooltip, because "why is this paper here" is the whole
   * reason the attachment exists. */
  function refPills(refs, canManage) {
    if (!refs || !refs.length) return '';
    return '<ul class="rmap-refs">' + refs.map(function (r) {
      var rel = RM.RELEVANCE[r.relevance] || 'Supporting';
      return '<li class="rmap-ref" data-ref="' + esc(r.id) + '" data-item="' + esc(r.item_id) + '">' +
        '<a class="rmap-ref-title" href="/rm/pages/library-paper.html?id=' + encodeURIComponent(r.item_id) + '">' +
          '📄 ' + esc(r.title_snapshot || r.item_id) +
          (r.year_snapshot ? ' <span class="rmap-ref-yr">(' + esc(r.year_snapshot) + ')</span>' : '') +
        '</a>' +
        '<span class="rmap-ref-rel" data-rel="' + esc(r.relevance) + '">' + esc(rel) + '</span>' +
        (r.note ? '<span class="rmap-ref-note">' + esc(r.note) + '</span>' : '') +
        '<span class="rmap-ref-by">— ' + esc(r.creator_name || 'someone') + '</span>' +
        (canManage(r)
          ? '<span class="rmap-ref-acts">' +
              '<button class="rf-btn-xs" data-act="roadmap-ref-edit" title="Edit the note">✎</button>' +
              '<button class="rf-btn-xs" data-act="roadmap-ref-remove" title="Detach this paper">✕</button>' +
            '</span>'
          : '') +
      '</li>';
    }).join('') + '</ul>';
  }

  /* The attach flow lives in roadmap-attach.js (R2). Until that module is
   * on the page there is nothing behind the button, so don't render one. */
  function addRefBtn(targetKind, targetId, label) {
    if (!window.ROADMAP_ATTACH) return '';
    return '<button class="rf-btn rf-btn-xs rmap-addref" data-act="roadmap-add-ref" ' +
      'data-target-kind="' + esc(targetKind) + '"' +
      (targetId ? ' data-target-id="' + esc(targetId) + '"' : '') + '>＋ ' + esc(label || 'Paper') + '</button>';
  }

  /* ── the figure board (V3.605) ──────────────────────────────── */

  /* The board is the roadmap's thesis in pictures: these are the figures
   * the output has to end up containing. It leads the Roadmap section
   * because it's the target — the experiments and analyses underneath are
   * how you get there. Numbers (Fig 1) and panel letters (A/B/C) are
   * derived from position, never authored, so reordering renumbers. */
  function renderBoard(f, rm, canEdit) {
    var figs = RM.boardFigures(rm);
    var prog = RM.figureProgressOf(rm);
    var head = '<div class="rmap-board-head">' +
      '<span class="rmap-board-label">Figure board — what we’re building</span>' +
      (prog.total
        ? '<span class="rmap-board-prog">' + prog.final + ' of ' + prog.total + ' final' +
          (prog.drafted ? ' · ' + prog.drafted + ' drafted' : '') + '</span>'
        : '') +
      (canEdit ? '<button class="rf-btn rf-btn-sm" data-act="edit-board">🖼 Edit figure board</button>' : '') +
    '</div>';

    if (!figs.length) {
      return '<div class="rmap-board">' + head +
        '<p class="rf-empty-sm">No figures on the board yet.' +
        (canEdit ? ' Upload the figures this output has to end up containing — they become the visual statement of the roadmap, and each analysis can point at the figure or panel it feeds.' : '') +
        '</p></div>';
    }
    return '<div class="rmap-board">' + head +
      '<div class="rmap-board-grid">' + figs.map(boardCard).join('') + '</div>' +
    '</div>';
  }

  function boardCard(x) {
    var st = RM.FIGURE_STATUS[x.status] || RM.FIGURE_STATUS.none;
    var whole = RM.imageUrl(x.image, 'medium');
    var full = RM.imageUrl(x.image, 'full');
    var art;
    if (whole) {
      art = '<a class="rmap-bfig-img" href="' + esc(full) + '" target="_blank" rel="noopener" title="Open full size">' +
        '<img loading="lazy" src="' + esc(whole) + '" alt="' + esc(x.title || x.label) + '"></a>';
    } else if (x.panels.length && x.panels.some(function (p) { return RM.imageUrl(p.image, 'thumb'); })) {
      // No composite uploaded yet — show the panels as a mosaic so the
      // card still says something visual.
      art = '<div class="rmap-bfig-img rmap-bfig-mosaic">' + x.panels.slice(0, 6).map(function (p) {
        var u = RM.imageUrl(p.image, 'thumb');
        return u
          ? '<a href="' + esc(RM.imageUrl(p.image, 'full')) + '" target="_blank" rel="noopener" title="' + esc(p.label + (p.title ? ' — ' + p.title : '')) + '">' +
              '<img loading="lazy" src="' + esc(u) + '" alt="' + esc(p.label) + '"><span>' + esc(p.letter) + '</span></a>'
          : '<span class="rmap-bfig-ph-sm">' + esc(p.letter) + '</span>';
      }).join('') + '</div>';
    } else {
      art = '<div class="rmap-bfig-img rmap-bfig-ph">🖼<span>no image yet</span></div>';
    }

    return '<figure class="rmap-bfig" id="rmap-' + esc(x.id) + '" data-bfig="' + esc(x.id) + '">' +
      art +
      '<figcaption class="rmap-bfig-cap">' +
        '<div class="rmap-bfig-top">' +
          '<span class="rmap-bfig-num">' + esc(x.label) + '</span>' +
          '<span class="rmap-bfig-title">' + esc(x.title || '(untitled figure)') + '</span>' +
          '<span class="rmap-bfig-st" style="color:' + st.color + ';background:' + st.bg + '">' + esc(st.label) + '</span>' +
        '</div>' +
        (x.caption ? '<p class="rmap-bfig-target">' + esc(x.caption) + '</p>' : '') +
        (x.panels.length
          ? '<div class="rmap-bfig-panels">' + x.panels.map(function (p) {
              return '<span class="rmap-panel-chip" title="' + esc(p.title || p.label) + '">' +
                '<b>' + esc(p.letter) + '</b>' + (p.title ? ' ' + esc(p.title) : '') + '</span>';
            }).join('') + '</div>'
          : '') +
        '<div class="rmap-bfig-fed" data-fed-for="' + esc(x.id) + '"></div>' +
      '</figcaption>' +
    '</figure>';
  }

  /* ── the detail-view section ────────────────────────────────── */

  /** Rendered synchronously from the focus doc; refs and claims arrive
   * later via hydrateSection() so the section paints immediately. */
  function renderSection(f, canEdit) {
    if (!f || f.level !== 'output') return '';
    var rm = RM.hydrate(f.roadmap);
    var prog = RM.progressOf(rm);

    var head = '<div class="rf-sec-head"><h2>Roadmap' +
      (prog.total
        ? ' <span class="rmap-progress" title="Analyses complete">' + prog.done + '/' + prog.total + ' analyses done</span>'
        : '') +
      '</h2>' +
      (canEdit
        ? '<span class="rf-sec-actions"><button class="rf-btn rf-btn-sm" data-act="edit-roadmap">✎ Edit roadmap</button></span>'
        : '') +
    '</div>';

    if (!rm.experiments.length) {
      return '<section class="rf-sec rmap-sec">' + head +
        renderBoard(f, rm, canEdit) +
        '<p class="rf-empty-sm">No experiments yet.' +
        (canEdit ? ' Lay out the experiments this output needs, the analyses each one yields, and the figure each analysis becomes.' : '') +
        '</p>' +
        '<div class="rmap-root-add">' + addRefBtn('roadmap', null, 'Reference paper') + '</div>' +
        '<div data-roadmap-refs="root"></div>' +
      '</section>';
    }

    var body = renderBoard(f, rm, canEdit) +
      (rm.intro_html ? '<div class="rf-richtext rmap-intro">' + sanitize(rm.intro_html) + '</div>' : '') +
      '<ol class="rmap-exps">' + rm.experiments.map(function (x, i) {
        return renderExperiment(x, i);
      }).join('') + '</ol>' +
      '<div class="rmap-root-refs">' +
        '<div class="rmap-root-head"><span class="rmap-root-label">Background reading for this output</span>' +
          addRefBtn('roadmap', null, 'Paper') + '</div>' +
        '<div data-roadmap-refs="root"></div>' +
      '</div>';

    return '<section class="rf-sec rmap-sec">' + head + body + '</section>';
  }

  function renderExperiment(x, idx) {
    var analyses = x.analyses || [];
    return '<li class="rmap-exp" id="rmap-' + esc(x.id) + '" data-exp="' + esc(x.id) + '">' +
      '<div class="rmap-exp-head">' +
        '<span class="rmap-num">' + (idx + 1) + '</span>' +
        '<h3 class="rmap-exp-title">' + esc(x.title || '(untitled experiment)') + '</h3>' +
        statusPill(x.status) +
      '</div>' +
      (x.description_html ? '<div class="rf-richtext rmap-exp-desc">' + sanitize(x.description_html) + '</div>' : '') +
      (analyses.length
        ? '<ul class="rmap-ans">' + analyses.map(function (a, j) {
            return renderAnalysis(a, idx, j);
          }).join('') + '</ul>'
        : '<p class="rf-empty-sm rmap-an-empty">No analyses defined for this experiment yet.</p>') +
      '<div class="rmap-exp-foot">' +
        addRefBtn('experiment', x.id, 'Paper for this experiment') +
        '<div data-roadmap-refs="' + esc(x.id) + '"></div>' +
      '</div>' +
    '</li>';
  }

  function renderAnalysis(a, expIdx, anIdx) {
    return '<li class="rmap-an" id="rmap-' + esc(a.id) + '" data-an="' + esc(a.id) + '">' +
      '<div class="rmap-an-head">' +
        '<span class="rmap-an-num">' + (expIdx + 1) + '.' + (anIdx + 1) + '</span>' +
        '<span class="rmap-an-title">' + esc(a.title || '(untitled analysis)') + '</span>' +
        statusPill(a.status) +
        '<span class="rmap-an-claims" data-claims-for="' + esc(a.id) + '"></span>' +
      '</div>' +
      (a.method_note ? '<p class="rmap-an-note">' + esc(a.method_note) + '</p>' : '') +
      figureChip(a.figure) +
      '<div class="rmap-an-foot">' +
        addRefBtn('analysis', a.id, 'Paper') +
        '<div data-roadmap-refs="' + esc(a.id) + '"></div>' +
      '</div>' +
    '</li>';
  }

  /** Fill the per-target ref hosts and the claim chips. Async because
   * both are separate reads; the section is already on screen. */
  async function hydrateSection(root, f, state) {
    if (!root || !f || f.level !== 'output') return;
    var canManage = function (r) {
      return !!(state && (state.isAdmin || (state.me && r.added_by === state.me.uid)));
    };
    try {
      var refs = await RM.listRefs(f.id);
      var byTarget = {};
      refs.forEach(function (r) {
        var key = (r.target && r.target.id) || 'root';
        (byTarget[key] = byTarget[key] || []).push(r);
      });
      root.querySelectorAll('[data-roadmap-refs]').forEach(function (host) {
        var key = host.getAttribute('data-roadmap-refs');
        host.innerHTML = refPills(byTarget[key] || [], canManage);
      });
    } catch (e) { console.warn('[research-roadmap] refs hydrate failed:', e && e.message); }

    // "🎯 N this week" per analysis — populated in R3 once weekly focus
    // areas can align to an analysis. Silent until then.
    try {
      var hosts = root.querySelectorAll('[data-claims-for]');
      if (!hosts.length) return;
      var claims = await RM.listClaims();
      var byAn = {};
      claims.forEach(function (c) { (byAn[c.analysis_id] = byAn[c.analysis_id] || []).push(c); });
      hosts.forEach(function (h) {
        var rows = byAn[h.getAttribute('data-claims-for')] || [];
        if (!rows.length) return;
        h.innerHTML = '<span class="rmap-claim" title="' +
          esc(rows.map(function (c) { return c.name; }).join(', ')) + '">🎯 ' +
          esc(rows.map(function (c) { return c.name; }).join(', ')) + '</span>';
      });
    } catch (e) { /* claims are a nicety — never break the section */ }
  }

  /* ── admin editor ───────────────────────────────────────────── */

  /* One modal for the whole tree. A working copy is re-rendered wholesale
   * on every structural change (add / delete / move), with collect()
   * reading the live inputs back into the draft first so nothing typed is
   * lost between renders. Saved once at the end — the doc is admin-write,
   * so there is no concurrent writer to merge against. */
  function openEditor(f, onDone) {
    if (!RM.isAdmin()) { alert('Only the PI can edit a roadmap.'); return; }
    var draft = RM.hydrate(f.roadmap);
    var m = RD.modal({ title: 'Roadmap — ' + (f.title || f.id), wide: true });
    var bulkFor = null;   // experiment id whose bulk-add textarea is open

    function statusSelect(cls, id, val) {
      return '<select class="' + cls + '" data-id="' + esc(id) + '">' +
        RM.STATUS_ORDER.map(function (s) {
          return '<option value="' + s + '"' + (s === val ? ' selected' : '') + '>' +
            esc(RM.STATUS_META[s].label) + '</option>';
        }).join('') + '</select>';
    }

    function analysisRow(a, xId) {
      var fig = a.figure;
      return '<div class="rmap-ed-an" data-an-id="' + esc(a.id) + '" data-exp-id="' + esc(xId) + '">' +
        '<div class="rmap-ed-an-top">' +
          '<input type="text" class="rmap-ed-an-title" data-id="' + esc(a.id) + '" placeholder="Analysis — e.g. Void space over time" value="' + esc(a.title) + '">' +
          statusSelect('rmap-ed-an-status', a.id, a.status) +
          '<button type="button" class="rf-btn-xs" data-ed="an-up" title="Move up">▲</button>' +
          '<button type="button" class="rf-btn-xs" data-ed="an-down" title="Move down">▼</button>' +
          '<button type="button" class="rf-btn-xs rf-btn-danger" data-ed="an-del" title="Delete analysis">✕</button>' +
        '</div>' +
        '<input type="text" class="rmap-ed-an-note" data-id="' + esc(a.id) + '" placeholder="How is it measured? (optional)" value="' + esc(a.method_note) + '">' +
        '<div class="rmap-ed-fig">' +
          '<label class="rmap-ed-check"><input type="checkbox" class="rmap-ed-fig-needed" data-id="' + esc(a.id) + '"' + (fig.needed ? ' checked' : '') + '> needs a figure</label>' +
          '<select class="rmap-ed-fig-kind" data-id="' + esc(a.id) + '">' +
            Object.keys(RM.FIGURE_KINDS).map(function (k) {
              return '<option value="' + k + '"' + (k === fig.kind ? ' selected' : '') + '>' + RM.FIGURE_KINDS[k].icon + ' ' + esc(RM.FIGURE_KINDS[k].label) + '</option>';
            }).join('') + '</select>' +
          '<input type="text" class="rmap-ed-fig-ref" data-id="' + esc(a.id) + '" placeholder="Fig 2b" value="' + esc(fig.figure_ref) + '">' +
          '<select class="rmap-ed-fig-status" data-id="' + esc(a.id) + '">' +
            Object.keys(RM.FIGURE_STATUS).map(function (k) {
              return '<option value="' + k + '"' + (k === fig.status ? ' selected' : '') + '>' + esc(RM.FIGURE_STATUS[k].label) + '</option>';
            }).join('') + '</select>' +
          '<input type="text" class="rmap-ed-fig-cap" data-id="' + esc(a.id) + '" placeholder="What the figure should show" value="' + esc(fig.caption_target) + '">' +
        '</div>' +
      '</div>';
    }

    function expBlock(x, i) {
      return '<fieldset class="rmap-ed-exp" data-exp-id="' + esc(x.id) + '">' +
        '<legend>Experiment ' + (i + 1) + '</legend>' +
        '<div class="rmap-ed-exp-top">' +
          '<input type="text" class="rmap-ed-exp-title" data-id="' + esc(x.id) + '" placeholder="Experiment — e.g. Confocal time-point measurements of granules in various conditions" value="' + esc(x.title) + '">' +
          statusSelect('rmap-ed-exp-status', x.id, x.status) +
          '<button type="button" class="rf-btn-xs" data-ed="exp-up" title="Move up">▲</button>' +
          '<button type="button" class="rf-btn-xs" data-ed="exp-down" title="Move down">▼</button>' +
          '<button type="button" class="rf-btn-xs rf-btn-danger" data-ed="exp-del" title="Delete experiment">✕</button>' +
        '</div>' +
        RESEARCH_COMPOSER.richToolbar() +
        '<div class="rf-richtext-edit rmap-ed-exp-desc" contenteditable="true" data-id="' + esc(x.id) + '">' + sanitize(x.description_html) + '</div>' +
        '<div class="rmap-ed-ans">' + x.analyses.map(function (a) { return analysisRow(a, x.id); }).join('') + '</div>' +
        (bulkFor === x.id
          ? '<div class="rmap-ed-bulk">' +
              '<textarea class="rmap-ed-bulk-text" rows="5" placeholder="One analysis per line:&#10;Void space over time&#10;Compaction of the functional phase over time&#10;…"></textarea>' +
              '<button type="button" class="rf-btn rf-btn-sm rf-btn-primary" data-ed="bulk-apply">Add these</button>' +
              '<button type="button" class="rf-btn rf-btn-sm" data-ed="bulk-cancel">Cancel</button>' +
            '</div>'
          : '') +
        '<div class="rmap-ed-exp-foot">' +
          '<button type="button" class="rf-btn rf-btn-sm" data-ed="an-add">＋ Analysis</button>' +
          (bulkFor === x.id ? '' : '<button type="button" class="rf-btn rf-btn-sm" data-ed="bulk-open">⤵ Paste a list</button>') +
        '</div>' +
      '</fieldset>';
    }

    function paint() {
      m.body.innerHTML =
        '<div class="rf-field">' +
          '<label>Intro — why this output needs what follows (optional)</label>' +
          RESEARCH_COMPOSER.richToolbar() +
          '<div class="rf-richtext-edit rmap-ed-intro" contenteditable="true">' + sanitize(draft.intro_html) + '</div>' +
        '</div>' +
        '<div class="rmap-ed-exps">' + draft.experiments.map(expBlock).join('') + '</div>' +
        '<button type="button" class="rf-btn rf-btn-sm" data-ed="exp-add">＋ Experiment</button>' +
        '<div class="rf-modal-actions">' +
          '<span class="rf-modal-err" data-err></span>' +
          '<button type="button" class="rf-btn" data-ed="cancel">Cancel</button>' +
          '<button type="button" class="rf-btn rf-btn-primary" data-ed="save">Save roadmap</button>' +
        '</div>';
      RESEARCH_COMPOSER.wireRich(m.body);
    }

    /* Read every live input back into the draft. Called before any
     * re-render and before save, so a structural click never discards
     * text the PI just typed. */
    function collect() {
      var intro = m.body.querySelector('.rmap-ed-intro');
      draft.intro_html = intro ? intro.innerHTML : draft.intro_html;
      var byExp = {}; draft.experiments.forEach(function (x) { byExp[x.id] = x; });
      var byAn = {};
      draft.experiments.forEach(function (x) { x.analyses.forEach(function (a) { byAn[a.id] = a; }); });

      function each(sel, fn) {
        m.body.querySelectorAll(sel).forEach(function (el) {
          var target = el.getAttribute('data-id');
          fn(el, target);
        });
      }
      each('.rmap-ed-exp-title', function (el, id) { if (byExp[id]) byExp[id].title = el.value; });
      each('.rmap-ed-exp-status', function (el, id) { if (byExp[id]) byExp[id].status = el.value; });
      each('.rmap-ed-exp-desc', function (el, id) { if (byExp[id]) byExp[id].description_html = el.innerHTML; });
      each('.rmap-ed-an-title', function (el, id) { if (byAn[id]) byAn[id].title = el.value; });
      each('.rmap-ed-an-status', function (el, id) { if (byAn[id]) byAn[id].status = el.value; });
      each('.rmap-ed-an-note', function (el, id) { if (byAn[id]) byAn[id].method_note = el.value; });
      each('.rmap-ed-fig-needed', function (el, id) { if (byAn[id]) byAn[id].figure.needed = el.checked; });
      each('.rmap-ed-fig-kind', function (el, id) { if (byAn[id]) byAn[id].figure.kind = el.value; });
      each('.rmap-ed-fig-ref', function (el, id) { if (byAn[id]) byAn[id].figure.figure_ref = el.value; });
      each('.rmap-ed-fig-status', function (el, id) { if (byAn[id]) byAn[id].figure.status = el.value; });
      each('.rmap-ed-fig-cap', function (el, id) { if (byAn[id]) byAn[id].figure.caption_target = el.value; });
    }

    function findExp(id) {
      for (var i = 0; i < draft.experiments.length; i++) if (draft.experiments[i].id === id) return i;
      return -1;
    }
    function move(arr, i, delta) {
      var j = i + delta;
      if (i < 0 || j < 0 || j >= arr.length) return;
      var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }

    m.body.addEventListener('click', async function (e) {
      var btn = e.target.closest('[data-ed]');
      if (!btn) return;
      var act = btn.getAttribute('data-ed');
      var expEl = btn.closest('[data-exp-id]');
      var anEl = btn.closest('[data-an-id]');
      var xId = expEl ? expEl.getAttribute('data-exp-id') : null;
      var xi = xId ? findExp(xId) : -1;
      var x = xi >= 0 ? draft.experiments[xi] : null;

      if (act === 'cancel') { m.close(); return; }

      if (act === 'save') {
        collect();
        btn.disabled = true; btn.textContent = 'Saving…';
        try {
          // Re-stamp order from array position so the render order the PI
          // just arranged is what listAll's sort reproduces.
          draft.experiments.forEach(function (ex, i) { ex.order = i * 10; });
          await RM.saveRoadmap(f.id, draft);
          m.close();
          if (onDone) await onDone();
        } catch (err) {
          btn.disabled = false; btn.textContent = 'Save roadmap';
          var errEl = m.body.querySelector('[data-err]');
          if (errEl) errEl.textContent = 'Save failed: ' + (err && err.message);
        }
        return;
      }

      collect();
      if (act === 'exp-add') {
        draft.experiments.push(RM.hydrateExperiment({}, draft.experiments.length));
      } else if (act === 'exp-del' && x) {
        if (!confirm('Delete experiment "' + (x.title || 'untitled') + '" and its ' + x.analyses.length + ' analyses?')) return;
        draft.experiments.splice(xi, 1);
      } else if (act === 'exp-up' && x) {
        move(draft.experiments, xi, -1);
      } else if (act === 'exp-down' && x) {
        move(draft.experiments, xi, 1);
      } else if (act === 'an-add' && x) {
        x.analyses.push(RM.hydrateAnalysis({}));
      } else if (act === 'bulk-open' && x) {
        bulkFor = x.id;
      } else if (act === 'bulk-cancel') {
        bulkFor = null;
      } else if (act === 'bulk-apply' && x) {
        var ta = expEl.querySelector('.rmap-ed-bulk-text');
        var lines = (ta ? ta.value : '').split('\n')
          // Tolerate "1)" / "1." / "- " prefixes — the list is usually
          // pasted straight out of a numbered plan.
          .map(function (s) { return s.replace(/^\s*(?:\d+[.)]|[-•*])\s*/, '').trim(); })
          .filter(Boolean);
        lines.forEach(function (t) { x.analyses.push(RM.hydrateAnalysis({ title: t })); });
        bulkFor = null;
      } else if (act === 'an-del' && x && anEl) {
        var aid = anEl.getAttribute('data-an-id');
        x.analyses = x.analyses.filter(function (a) { return a.id !== aid; });
      } else if ((act === 'an-up' || act === 'an-down') && x && anEl) {
        var id2 = anEl.getAttribute('data-an-id');
        var ai = -1;
        x.analyses.forEach(function (a, i) { if (a.id === id2) ai = i; });
        move(x.analyses, ai, act === 'an-up' ? -1 : 1);
      } else {
        return;
      }
      paint();
    });

    paint();
  }

  /* ── the student band on the hub (V3.603) ───────────────────── */

  /* The research map shows what the lab is building. It never said what a
   * student should DO about it. This band answers three questions in the
   * order a new student asks them: what are we driving toward, what is
   * unclaimed that I could pick up, and who is already on what.
   *
   * Structure comes from state.foci (already loaded — roadmaps ride on
   * the card docs), so the only extra read is one whole-collection get of
   * roadmapClaims. */
  async function renderHubBand(host, state) {
    if (!host || !RM) return;
    var cards = (state.foci || []).filter(function (f) {
      return f.level === 'output' && !RM.isEmpty(RM.hydrate(f.roadmap));
    });
    if (!cards.length) { host.innerHTML = ''; return; }

    var week = window.FOCUS_AREAS ? FOCUS_AREAS.weekIdFor() : '';
    var claims = [];
    try { claims = await RM.listClaims(); } catch (e) {}
    // Claim docs are keyed {uid}__{analysisId} and persist across weeks;
    // only this week's are "who's on it now".
    var thisWeek = claims.filter(function (c) { return !week || c.week_id === week; });
    var byAnalysis = {};
    thisWeek.forEach(function (c) { (byAnalysis[c.analysis_id] = byAnalysis[c.analysis_id] || []).push(c); });

    var goals = [], open = [], taken = [];
    cards.forEach(function (f) {
      var rm = RM.hydrate(f.roadmap);
      var prog = RM.progressOf(rm);
      goals.push({ f: f, prog: prog });
      RM.flattenAnalyses(rm).forEach(function (a) {
        var who = byAnalysis[a.analysis_id] || [];
        var row = { f: f, a: a, who: who };
        if (who.length) taken.push(row);
        else if (a.analysis.status !== 'done') open.push(row);
      });
    });
    // Blocked first: an analysis someone gave up on is the most useful
    // thing to surface, not the least. (`|| 3` would be wrong here —
    // blocked's rank IS 0, which is falsy.)
    var rank = { blocked: 0, planned: 1, running: 2 };
    function rankOf(r) {
      var v = rank[r.a.analysis.status];
      return typeof v === 'number' ? v : 3;
    }
    open.sort(function (x, y) { return rankOf(x) - rankOf(y); });

    host.innerHTML =
      '<section class="rf-band rmap-band">' +
        '<div class="rf-band-head"><div>' +
          '<h2 class="rf-band-title">How the lab moves forward</h2>' +
          '<p class="rf-band-sub">What we’re driving toward, what’s unclaimed, and who’s on what this week.</p>' +
        '</div></div>' +
        '<div class="rmap-band-cols">' +
          goalsCol(goals) +
          openCol(open) +
          takenCol(taken) +
        '</div>' +
      '</section>';
  }

  function goalsCol(goals) {
    return '<div class="rmap-band-col">' +
      '<h3 class="rmap-band-h">🎯 What we’re driving toward</h3>' +
      goals.map(function (g) {
        var pct = g.prog.total ? Math.round((g.prog.done / g.prog.total) * 100) : 0;
        return '<a class="rmap-goal" href="/rm/pages/research.html?id=' + encodeURIComponent(g.f.id) + '">' +
          '<span class="rmap-goal-title">' + esc(g.f.title || g.f.id) + '</span>' +
          (g.f.one_liner ? '<span class="rmap-goal-liner">' + esc(g.f.one_liner) + '</span>' : '') +
          '<span class="rmap-goal-bar"><span style="width:' + pct + '%"></span></span>' +
          '<span class="rmap-goal-num">' + g.prog.done + ' of ' + g.prog.total + ' analyses done</span>' +
        '</a>';
      }).join('') +
    '</div>';
  }

  function openCol(open) {
    return '<div class="rmap-band-col">' +
      '<h3 class="rmap-band-h">🙋 Open work you could pick up</h3>' +
      (open.length
        ? open.map(function (r) {
            var fig = r.a.analysis.figure;
            return '<div class="rmap-open" data-foci="' + esc(r.f.id) + '" data-an="' + esc(r.a.analysis_id) + '">' +
              '<div class="rmap-open-head">' +
                '<a class="rmap-open-title" href="/rm/pages/research.html?id=' + encodeURIComponent(r.f.id) + '#rmap-' + esc(r.a.analysis_id) + '">' +
                  esc(r.a.analysis_title || '(untitled analysis)') + '</a>' +
                statusPill(r.a.analysis.status) +
              '</div>' +
              '<div class="rmap-open-ctx">' + esc(r.f.title) + ' · ' + esc(r.a.experiment_title || 'experiment') + '</div>' +
              (fig && fig.needed && fig.caption_target
                ? '<div class="rmap-open-fig">→ ' + esc(fig.caption_target) + '</div>' : '') +
              (window.FOCUS_AREAS
                ? '<button class="rf-btn rf-btn-xs rf-btn-primary" data-act="roadmap-claim">🎯 Make this my focus</button>'
                : '') +
            '</div>';
          }).join('')
        : '<p class="rf-empty-sm">Every analysis on every roadmap is claimed or done. Ask the PI what’s next.</p>') +
    '</div>';
  }

  function takenCol(taken) {
    return '<div class="rmap-band-col">' +
      '<h3 class="rmap-band-h">👥 Who’s on what this week</h3>' +
      (taken.length
        ? taken.map(function (r) {
            return '<div class="rmap-taken">' +
              '<a class="rmap-taken-title" href="/rm/pages/research.html?id=' + encodeURIComponent(r.f.id) + '#rmap-' + esc(r.a.analysis_id) + '">' +
                esc(r.a.analysis_title) + '</a>' +
              '<span class="rmap-taken-who">' + r.who.map(function (c) { return esc(c.name || 'someone'); }).join(', ') + '</span>' +
              '<span class="rmap-taken-ctx">' + esc(r.f.title) + '</span>' +
            '</div>';
          }).join('')
        : '<p class="rf-empty-sm">Nobody has aligned a week to a specific analysis yet. Team Focus and My Day are where that happens.</p>') +
    '</div>';
  }

  /** "🎯 Make this my focus" — creates a focus area for the signed-in
   * user's current week, aligned to this analysis, and mirrors the claim
   * so the rest of the lab sees it's taken. */
  async function claimAnalysis(btn, state) {
    var wrap = btn.closest('[data-an]');
    if (!wrap || !window.FOCUS_AREAS) return;
    var fociId = wrap.getAttribute('data-foci');
    var anId = wrap.getAttribute('data-an');
    var card = (state.foci || []).filter(function (f) { return f.id === fociId; })[0];
    if (!card) return;
    var row = RM.flattenAnalyses(card.roadmap).filter(function (a) { return a.analysis_id === anId; })[0];
    if (!row) return;

    if (!confirm('Make "' + row.analysis_title + '" your focus for this week?\n\n' +
      'It becomes a proposed focus area on your My Day and Team Focus, and the lab sees it as taken. ' +
      'Your mentor signs off from there.')) return;

    btn.disabled = true; btn.textContent = 'Claiming…';
    try {
      var me = firebridge.getUser();
      var fig = row.analysis.figure;
      var created = await FOCUS_AREAS.create(me.uid, {
        title: row.analysis_title,
        description: 'From the ' + (card.title || fociId) + ' roadmap — ' +
          (row.experiment_title || 'experiment') +
          (fig && fig.needed && fig.caption_target ? '. Figure it feeds: ' + fig.caption_target : '') + '.',
        focus_ref: {
          id: fociId, title: card.title || fociId, level: 'output',
          analysis_id: anId, analysis_title: row.analysis_title,
          experiment_id: row.experiment_id,
        },
      });
      // create() writes focus_ref straight through, so the mirror is ours.
      await RM.setClaim({
        uid: me.uid, foci_id: fociId, experiment_id: row.experiment_id,
        analysis_id: anId, analysis_title: row.analysis_title, week_id: created.weekId,
      });
      if (window.TOAST) TOAST.success('It’s yours this week — see it on My Day.');
      return true;
    } catch (err) {
      btn.disabled = false; btn.textContent = '🎯 Make this my focus';
      if (window.TOAST) TOAST.error('Could not claim that: ' + (err && err.message));
      return false;
    }
  }

  window.RESEARCH_ROADMAP = {
    renderSection: renderSection,
    hydrateSection: hydrateSection,
    openEditor: openEditor,
    renderHubBand: renderHubBand,
    claimAnalysis: claimAnalysis,
    statusPill: statusPill,
    figureChip: figureChip,
  };
})();
