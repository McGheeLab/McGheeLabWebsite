/* myweek-report.js — V3.854 — "✓ Report to My Week" from the canvas.
 *
 * The notebook canvas and a paper's figure board show a ✓ at the top-left
 * of every card and region (whiteboard.js opts.report). Tapping it opens
 * THIS picker: the user's My Week steps from four weeks back through this
 * week — "Needs a result" first, then "Already has an outcome" — and picking
 * one records the card as that step's result through the SAME writer My
 * Week uses (DAY_DISTRIBUTE.saveOutcome, closeAs 'done'), so the step is
 * marked done, its copies cascade, and the PMR ledger / My Week show the
 * card link (V3.853 outcome.links[]). The host then stamps the card
 * (item.myweek[]) so its ✓ fills.
 *
 * Globals: window.MYWEEK_REPORT = { open, close, describeCard, loadSteps }
 * Depends: window.DAY_DISTRIBUTE (listRange, saveOutcome), window.TOAST;
 * optional: window.CANVAS_WIDGETS (summary(), closeMenus()).
 * Styles: .cw-pop family (rm/css/canvas-widgets.css) + .mwr-*.
 * No browser popups anywhere. */
(function () {
  'use strict';

  var POP = null;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function DD() { return window.DAY_DISTRIBUTE || null; }
  function toast(kind, msg) { if (window.TOAST && TOAST[kind]) TOAST[kind](msg); }
  function localToday() {
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
    var d = new Date(+p[0], +p[1] - 1, +p[2]);
    var dow = (d.getDay() + 6) % 7;   // Monday = 0
    return shiftDate(dateStr, -dow);
  }
  function fmtDate(dateStr) {
    if (!dateStr) return '';
    var p = String(dateStr).split('-');
    var d = new Date(+p[0], +p[1] - 1, +p[2]);
    var today = localToday();
    if (dateStr === today) return 'Today';
    if (dateStr === shiftDate(today, -1)) return 'Yesterday';
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  }
  function plainText(html) {
    var d = document.createElement('div'); d.innerHTML = String(html || '');
    return (d.textContent || '').replace(/\s+/g, ' ').trim();
  }

  var KIND_LABELS = {
    figcard: 'Planned figure', experiment: 'Experiment', panel: 'Panel', snip: 'Reference figure',
    quote: 'Quote', litref: 'Lit review', litreview: 'Lit review', note: 'Note', checklist: 'Checklist',
    figure: 'Figure / photo', html: 'HTML frame', calc: 'Calculator', protocol: 'Protocol run',
    inventory: 'Inventory item', paper: 'From a paper', paperquote: 'Quote', action: 'Something I did',
    boardlink: 'Board link', region: 'Region',
  };

  /* What a card is called in the result link: title · caption · note text ·
   * the widget registry's summary · its kind. Thumbnail from the card's
   * image when it has one. */
  function describeCard(it) {
    it = it || {};
    var d = it.data || {};
    var cell = (d.cells && d.cells[0]) || {};
    var kind = it.type === 'region' ? 'region' : (it.kind || 'card');
    var kindLabel = KIND_LABELS[kind] || kind;
    var summary = '';
    if (it.type === 'widget' && window.CANVAS_WIDGETS && CANVAS_WIDGETS.summary) {
      try { summary = String(CANVAS_WIDGETS.summary(it) || ''); } catch (e) { summary = ''; }
    }
    var title = String(it.title || d.caption || cell.caption || plainText(d.html) || summary || it.text || '').trim().slice(0, 140);
    return { title: title || kindLabel, thumb: String(d.url || cell.url || ''), item_kind: kind, kindLabel: kindLabel };
  }

  /* The user's steps worth reporting to: four weeks back through the end of
   * this week, never cancelled, newest first. */
  async function loadSteps() {
    var dd = DD();
    if (!dd || !dd.listRange) throw new Error('My Week is not loaded on this page.');
    var mon = mondayOf(localToday());
    var rows = await dd.listRange(shiftDate(mon, -28), shiftDate(mon, 6));
    rows = (rows || []).filter(function (it) { return it && it.id && it.status !== 'cancelled'; });
    rows.sort(function (a, b) {
      return String(b.date || '').localeCompare(String(a.date || '')) ||
        String(b.startTime || '').localeCompare(String(a.startTime || ''));
    });
    return rows;
  }

  /* ── the anchored popover (the ＋ Insert menu's look) ── */
  function close() {
    if (POP) { POP.remove(); POP = null; }
    document.removeEventListener('pointerdown', onDocDown, true);
    document.removeEventListener('keydown', onDocKey, true);
  }
  function onDocDown(e) { if (POP && !POP.contains(e.target)) close(); }
  function onDocKey(e) { if (e.key === 'Escape') { e.stopPropagation(); close(); } }
  function place(pop, anchor, point) {
    document.body.appendChild(pop);
    var r = anchor && anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : null;
    var x = r ? r.left : (point ? point.x : 20), y = r ? r.bottom + 6 : (point ? point.y : 20);
    var pr = pop.getBoundingClientRect();
    if (x + pr.width > innerWidth - 8) x = Math.max(8, innerWidth - pr.width - 8);
    if (y + pr.height > innerHeight - 8) y = Math.max(8, (r ? r.top : y) - pr.height - 6);
    if (y < 8) y = 8;
    pop.style.left = Math.round(x) + 'px'; pop.style.top = Math.round(y) + 'px';
    POP = pop;
    setTimeout(function () {
      document.addEventListener('pointerdown', onDocDown, true);
      document.addEventListener('keydown', onDocKey, true);
    }, 0);
  }

  function statusLine(it, card) {
    var bits = [fmtDate(it.date)];
    bits.push(it.status === 'done' ? 'done' : it.status === 'skipped' ? 'skipped' : 'planned');
    var oc = it.outcome;
    if (oc) bits.push(oc.kind === 'result' ? ICON.svg('check-circle') + ' has a result' : oc.kind === 'barrier' ? ICON.svg('construction') + ' barrier recorded' : '◌ no result recorded');
    if (linkedTo(it, card)) bits.push('<span class="mwr-link">already linked to this card</span>');
    return bits.join(' · ');
  }
  function linkedTo(it, card) {
    var links = (it.outcome && Array.isArray(it.outcome.links)) ? it.outcome.links : [];
    return links.some(function (l) { return l && l.itemId === card.itemId && (l.boardId || '') === (card.boardId || ''); });
  }
  function glyph(it) { return it.status === 'done' ? '✓' : it.status === 'skipped' ? '✗' : '○'; }

  /* open({ anchor | point, card, onReported(step, link) })
   * card: { kind:'figure_board_item'|'notebook_item', boardId, itemId,
   *         paperId, entryId, boardTitle, item_kind, title, thumb, url } */
  async function open(opts) {
    opts = opts || {};
    var card = opts.card || {};
    if (!card.itemId) return;
    if (window.CANVAS_WIDGETS && CANVAS_WIDGETS.closeMenus) { try { CANVAS_WIDGETS.closeMenus(); } catch (e) {} }
    close();
    var pop = document.createElement('div');
    pop.className = 'cw-pop mwr-pop';
    pop.innerHTML =
      '<div class="cw-pop-head">Report as the result of…</div>' +
      '<div class="mwr-card">' + (card.thumb ? '<img src="' + esc(card.thumb) + '" alt="">' : '<span class="mwr-glyph">' + ICON.svg(card.kind === 'figure_board_item' ? 'chart-bar' : 'book-open') + '</span>') +
        '<span class="mwr-ctitle">' + esc(card.title || 'this card') + '</span></div>' +
      '<input type="search" class="cw-pop-q" placeholder="Find a step…" autocomplete="off" aria-label="Find a step" hidden>' +
      '<div class="cw-pop-list"><div class="cw-empty">Loading your steps…</div></div>' +
      '<div class="mwr-foot"><a href="/rm/pages/my-week.html" target="_blank" rel="noopener">Open My Week ↗</a></div>';
    place(pop, opts.anchor || null, opts.point || null);
    var list = pop.querySelector('.cw-pop-list');
    var q = pop.querySelector('.cw-pop-q');

    var steps;
    try { steps = await loadSteps(); }
    catch (err) {
      if (POP === pop) list.innerHTML = '<div class="cw-empty">' + esc(err && err.message || 'Could not load your steps.') + '</div>';
      return;
    }
    if (POP !== pop) return;   // closed while loading

    function draw() {
      var terms = q.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
      var show = steps.filter(function (it) {
        var hay = (it.title + ' ' + (it.notes || '') + ' ' + (it.date || '')).toLowerCase();
        return terms.every(function (t) { return hay.indexOf(t) >= 0; });
      });
      var needs = show.filter(function (it) { return !it.outcome; });
      var has = show.filter(function (it) { return !!it.outcome; });
      function rows(arr) {
        return arr.map(function (it) {
          var dis = linkedTo(it, card);
          return '<button type="button" class="cw-row mwr-row" data-id="' + esc(it.id) + '"' + (dis ? ' disabled' : '') + '>' +
            '<span class="cw-ic">' + glyph(it) + '</span>' +
            '<span class="cw-txt"><b>' + esc(it.title || '(untitled step)') + '</b><small>' + statusLine(it, card) + '</small></span></button>';
        }).join('');
      }
      if (!steps.length) {
        list.innerHTML = '<div class="cw-empty">No My Week steps in the last four weeks. Plan one on My Week first.</div>';
        return;
      }
      list.innerHTML = (needs.length ? '<div class="cw-group">Needs a result</div>' + rows(needs) : '') +
        (has.length ? '<div class="cw-group">Already has an outcome — add this card</div>' + rows(has) : '') +
        (!needs.length && !has.length ? '<div class="cw-empty">Nothing matches.</div>' : '');
    }
    q.hidden = steps.length <= 6;
    draw();
    q.addEventListener('input', draw);
    q.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { var first = list.querySelector('.mwr-row:not([disabled])'); if (first) first.click(); }
    });
    list.addEventListener('click', function (e) {
      var b = e.target.closest('.mwr-row'); if (!b || b.disabled) return;
      var step = steps.filter(function (it) { return it.id === b.dataset.id; })[0];
      if (step) pick(step, card, opts.onReported);
    });
    if (!q.hidden) setTimeout(function () { try { q.focus(); } catch (e) {} }, 30);
  }

  async function pick(step, card, onReported) {
    var dd = DD();
    close();
    var link = {
      kind: card.kind, boardId: card.boardId || '', itemId: card.itemId, paperId: card.paperId || '', entryId: card.entryId || '',
      boardTitle: card.boardTitle || '', item_kind: card.item_kind || '', title: card.title || '', url: card.url || '', thumb: card.thumb || '',
    };
    var ex = step.outcome || null;
    var links = (ex && Array.isArray(ex.links) ? ex.links : [])
      .filter(function (l) { return !(l && l.itemId === card.itemId && (l.boardId || '') === (card.boardId || '')); })
      .concat([link]);
    var payload = {
      kind: 'result',
      summary: ex ? (ex.summary || '') : '',
      image: ex ? (ex.image || null) : null,
      notebook_entry_ids: ex ? (ex.notebook_entry_ids || []) : [],
      links: links,
    };
    var before = step.status, hadOutcome = !!ex;
    try { await dd.saveOutcome(step, payload, { closeAs: 'done' }); }
    catch (err) {
      console.error('[myweek-report] save failed', err);
      toast('error', 'Could not report the result: ' + (err && err.message));
      return;
    }
    var tail = (step.status === 'done' && before !== 'done') ? ' — marked done ✓' : hadOutcome ? ' — added to its result ✓' : ' ✓';
    toast('success', 'Reported as the result of “' + (step.title || 'the step') + '”' + tail);
    if (typeof onReported === 'function') {
      try { await onReported(step, link); } catch (e) { console.warn('[myweek-report] onReported failed', e); }
    }
  }

  window.MYWEEK_REPORT = { open: open, close: close, describeCard: describeCard, loadSteps: loadSteps };
})();
