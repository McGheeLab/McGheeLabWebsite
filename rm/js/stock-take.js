/* stock-take.js — "how much did you take?" (V3.646)
 *
 * The whole feature stands or falls on this sheet, because it is the only part
 * a student touches every day, usually one-handed, at a bench, in gloves.
 *
 * DESIGN RULES, and why each one is a rule:
 *
 * - PRESET CHIPS ARE THE PRIMARY INPUT, not the number field. Tapping a chip is
 *   one thumb and no keyboard; the field is the escape hatch. Tapping the SAME
 *   chip again ADDS to the running amount (5 mL twice = 10 mL), which is what
 *   makes the common case reachable without ever opening a keypad.
 * - NO CHIPS WHEN THE UNIT IS UNKNOWN. Guessing produces "took 5 boxes of a
 *   liquid". INV_QTY.presets() returns [] and we show only the field.
 * - THE BUTTON LABEL RESTATES THE AMOUNT ("Took 50 mL"). The label IS the
 *   confirmation, so there is no second are-you-sure dialog.
 * - NEGATIVE IS ALLOWED, behind one confirm. Someone who finds the bottle
 *   already empty must be able to say so; blocking them means they record
 *   NOTHING, which is strictly worse than a negative number a manager can
 *   reconcile from the ledger.
 * - THE WORK LINK IS AUTO-FILLED, NEVER ASKED. If a notebook entry is open we
 *   prefill it as a removable chip. One more required field is one more reason
 *   to skip recording at all.
 * - UNDO WRITES A COMPENSATING ROW, never a delete (see INV_QTY.undo).
 *
 * mode:'set' is the manager override: same sheet, absolute value, and a REQUIRED
 * reason — a recount with no reason is an unexplained number. Undo is disabled
 * there because an adjustment IS the correction.
 *
 * Global: window.STOCK_TAKE
 */
(function () {
  'use strict';

  var CSS =
    '.stk-head{display:flex;flex-direction:column;gap:2px;}' +
    '.stk-name{font-size:17px;font-weight:650;line-height:1.25;}' +
    '.stk-code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;' +
      'color:var(--text-muted,#64748b);background:var(--bg,#f1f5f9);border-radius:5px;' +
      'padding:1px 6px;align-self:flex-start;}' +
    '.stk-big{font-size:26px;font-weight:700;letter-spacing:-.01em;margin-top:6px;}' +
    '.stk-big small{font-size:14px;font-weight:500;color:var(--text-muted,#64748b);}' +
    '.stk-bar{height:6px;border-radius:3px;background:var(--border,#e2e8f0);overflow:hidden;margin-top:6px;}' +
    '.stk-bar i{display:block;height:100%;background:var(--green,#16a34a);transition:width .18s;}' +
    '.stk-bar.is-low i{background:var(--amber,#d97706);}' +
    '.stk-bar.is-out i{background:var(--red,#dc2626);}' +
    '.stk-label{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;' +
      'color:var(--text-muted,#64748b);margin-bottom:-4px;}' +
    '.stk-chips{display:flex;flex-wrap:wrap;gap:8px;}' +
    '.stk-chip{flex:1 1 auto;min-width:64px;min-height:56px;font-size:17px;font-weight:600;' +
      'border:1px solid var(--border,#e2e8f0);border-radius:12px;background:var(--card,#fff);' +
      'color:var(--text,#0f172a);cursor:pointer;}' +
    '.stk-chip:active{transform:scale(.96);}' +
    '.stk-chip.is-on{border-color:var(--primary,#2563eb);box-shadow:inset 0 0 0 1px var(--primary,#2563eb);}' +
    '.stk-amt{display:flex;align-items:center;gap:8px;}' +
    '.stk-step{min-width:52px;min-height:52px;font-size:24px;line-height:1;border-radius:12px;' +
      'border:1px solid var(--border,#e2e8f0);background:var(--card,#fff);color:var(--text,#0f172a);cursor:pointer;}' +
    '.stk-amt input{text-align:center;font-size:20px!important;font-weight:600;}' +
    '.stk-amt select{max-width:104px;}' +
    '.stk-after{font-size:14px;font-variant-numeric:tabular-nums;}' +
    '.stk-after.is-low{color:var(--amber,#d97706);font-weight:600;}' +
    '.stk-after.is-out{color:var(--red,#dc2626);font-weight:700;}' +
    '.stk-more{background:none;border:none;padding:0;font-size:13px;text-align:left;' +
      'color:var(--primary,#2563eb);cursor:pointer;}' +
    '.stk-ctx{display:inline-flex;align-items:center;gap:6px;font-size:12px;align-self:flex-start;' +
      'background:var(--bg,#f1f5f9);border-radius:999px;padding:4px 10px;color:var(--text-muted,#64748b);}' +
    '.stk-ctx button{background:none;border:none;cursor:pointer;font-size:14px;line-height:1;' +
      'color:var(--text-muted,#64748b);padding:0;}' +
    '.stk-go{min-height:54px;font-size:17px;font-weight:650;border:none;border-radius:12px;' +
      'background:var(--primary,#2563eb);color:#fff;cursor:pointer;}' +
    '.stk-go[disabled]{opacity:.45;cursor:default;}' +
    '.stk-go.is-warn{background:var(--red,#dc2626);}' +
    '.stk-done{display:flex;align-items:center;justify-content:space-between;gap:12px;' +
      'font-size:15px;padding:6px 0;}' +
    '.stk-undo{min-height:44px;padding:0 16px;font-size:15px;font-weight:600;border-radius:10px;' +
      'border:1px solid var(--border,#e2e8f0);background:var(--card,#fff);cursor:pointer;}' +
    '.stk-err{font-size:13px;color:var(--red,#dc2626);}';

  var _css = false;
  function ensureCSS() {
    if (_css) return;
    var s = document.createElement('style');
    s.textContent = CSS;
    document.head.appendChild(s);
    _css = true;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function canManage() {
    if (typeof firebridge === 'undefined') return false;
    if (firebridge.isAdmin && firebridge.isAdmin()) return true;
    return !!(firebridge.hasCapability && firebridge.hasCapability('inventory:manage'));
  }

  /* The work link, discovered rather than requested. The notebook keeps its
   * open doc id on the DOM, so a scan started from a notebook entry can file
   * the usage against it without asking a single question. */
  function detectContext() {
    try {
      var body = document.getElementById('ln-body');
      if (!body) return null;
      var host = document.querySelector('[data-entry-id]');
      var id = host ? host.getAttribute('data-entry-id') : null;
      if (!id && typeof window.LAB_NOTEBOOK_STATE === 'object' && window.LAB_NOTEBOOK_STATE) {
        id = window.LAB_NOTEBOOK_STATE.docId || null;
      }
      if (!id) return null;
      var t = document.querySelector('.ln-title, #ln-title');
      return { notebookEntryId: id, label: (t && t.textContent || 'this notebook entry').trim().slice(0, 48) };
    } catch (e) { return null; }
  }

  function open(opts) {
    opts = opts || {};
    var item = opts.item;
    if (!item) throw new Error('STOCK_TAKE.open needs an item');
    if (typeof APP_SHEET === 'undefined') throw new Error('app-sheet.js not loaded');
    ensureCSS();

    var mode = opts.mode === 'set' ? 'set' : 'take';
    if (mode === 'set' && !canManage()) mode = 'take';
    var Q = window.INV_QTY;
    var unit = item.qty_unit || '';
    var family = Q.unitFamily(unit);
    var ctx = opts.context !== undefined ? opts.context : detectContext();

    // The running amount. Starts empty for a take (so a chip tap is the first
    // decision) and at the CURRENT value for a recount (so a manager nudges
    // rather than retypes).
    var amount = mode === 'set' ? Q.num(item.qty_remaining) : 0;
    var chosenUnit = unit;
    var reason = '';
    var note = '';
    var busy = false;

    ensureCSS();
    APP_SHEET.open({
      title: mode === 'set' ? 'Correct the amount left' : 'Record what you took',
      build: function (body, api) {
        function remainingAfter() {
          if (mode === 'set') return Q.clean(amount);
          var q = amount;
          if (chosenUnit && unit && chosenUnit !== unit) {
            var c = Q.convert(q, chosenUnit, unit);
            if (c != null) q = c;
          }
          return Q.clean(Q.num(item.qty_remaining) - q);
        }
        function sevOf(rem) {
          return Q.severity(Object.assign({}, item, { qty_remaining: rem, qty_tracked: true }));
        }

        var presets = mode === 'set' ? [] : Q.presets(item);
        var frac = Q.fractionLeft(item);
        var sevNow = Q.severity(item);

        body.innerHTML =
          '<div class="stk-head">' +
            '<span class="stk-name">' + esc(item.name || 'Item') + '</span>' +
            (opts.labelCode ? '<span class="stk-code">' + esc(opts.labelCode) + '</span>' : '') +
            '<span class="stk-big">' + esc(Q.summary(item) || '—') + '</span>' +
            (frac != null
              ? '<div class="stk-bar' + (sevNow === 'low' ? ' is-low' : sevNow === 'out' ? ' is-out' : '') +
                '"><i style="width:' + Math.round(frac * 100) + '%"></i></div>'
              : '') +
          '</div>' +
          (presets.length
            ? '<div class="stk-label">Quick amounts</div><div class="stk-chips">' +
              presets.map(function (v) {
                return '<button type="button" class="stk-chip" data-v="' + v + '">' + v + '</button>';
              }).join('') + '</div>'
            : '') +
          '<div class="stk-label">' + (mode === 'set' ? 'Set remaining to' : 'Amount') + '</div>' +
          '<div class="stk-amt">' +
            '<button type="button" class="stk-step" data-d="-1" aria-label="Less">−</button>' +
            '<input type="number" class="stk-n" inputmode="decimal" step="any" min="' +
              (mode === 'set' ? '0' : '0') + '" value="' + (amount || '') + '">' +
            '<button type="button" class="stk-step" data-d="1" aria-label="More">+</button>' +
            (family && mode === 'take'
              ? '<select class="stk-u">' + Object.keys({ uL: 1, mL: 1, L: 1, ug: 1, mg: 1, g: 1, kg: 1 })
                  .filter(function (u) { return Q.unitFamily(u) === family; })
                  .map(function (u) {
                    return '<option value="' + u + '"' + (u === unit ? ' selected' : '') + '>' + u + '</option>';
                  }).join('') + '</select>'
              : (unit ? '<span style="font-size:15px;color:var(--text-muted)">' + esc(unit) + '</span>' : '')) +
          '</div>' +
          '<div class="stk-after"></div>' +
          (mode === 'set'
            ? '<div class="stk-label">Why</div>' +
              '<select class="stk-reason">' +
                '<option value="">Choose a reason…</option>' +
                '<option value="recount">Recounted by hand</option>' +
                '<option value="spill">Spilled / lost</option>' +
                '<option value="disposed">Disposed of</option>' +
                '<option value="transferred">Transferred out</option>' +
                '<option value="correction">Correcting an earlier mistake</option>' +
              '</select>'
            : '') +
          (ctx
            ? '<span class="stk-ctx">→ ' + esc(ctx.label || 'this entry') +
              '<button type="button" class="stk-ctx-x" aria-label="Don’t link">×</button></span>'
            : '') +
          '<button type="button" class="stk-more">+ add a note</button>' +
          '<textarea class="stk-note" rows="2" placeholder="Optional note" hidden></textarea>' +
          '<div class="stk-err" hidden></div>' +
          '<button type="button" class="stk-go"></button>';

        var $ = function (s) { return body.querySelector(s); };
        var nEl = $('.stk-n'), goEl = $('.stk-go'), afterEl = $('.stk-after'),
            errEl = $('.stk-err'), uEl = $('.stk-u'), reasonEl = $('.stk-reason');

        function paint() {
          var after = remainingAfter();
          var sev = sevOf(after);
          var u = unit ? ' ' + unit : '';
          afterEl.textContent = amount
            ? Q.clean(Q.num(item.qty_remaining)) + u + ' → ' + after + u
            : '';
          afterEl.className = 'stk-after' + (after < 0 ? ' is-out' : sev === 'low' ? ' is-low' : sev === 'out' ? ' is-out' : '');

          body.querySelectorAll('.stk-chip').forEach(function (c) {
            c.classList.toggle('is-on', amount > 0 && Q.clean(amount % Number(c.dataset.v)) === 0);
          });

          var label;
          if (mode === 'set') label = amount || amount === 0 ? 'Set to ' + Q.clean(amount) + u : 'Set the amount';
          else label = amount ? 'Took ' + Q.clean(amount) + (chosenUnit ? ' ' + chosenUnit : '') : 'Choose an amount';
          goEl.textContent = label;
          goEl.classList.toggle('is-warn', after < 0);
          goEl.disabled = busy || (mode === 'take' ? !amount : !(amount || amount === 0));
        }

        body.querySelectorAll('.stk-chip').forEach(function (c) {
          // Tapping the same chip again ADDS — the one-handed win.
          c.onclick = function () { amount = Q.clean(amount + Number(c.dataset.v)); nEl.value = amount; paint(); };
        });
        body.querySelectorAll('.stk-step').forEach(function (b) {
          b.onclick = function () {
            var base = (mode === 'take' && Q.presets(item)[0]) || 1;
            amount = Q.clean(Math.max(0, amount + Number(b.dataset.d) * base));
            nEl.value = amount || ''; paint();
          };
        });
        nEl.oninput = function () { amount = Q.num(nEl.value, 0); paint(); };
        if (uEl) uEl.onchange = function () { chosenUnit = uEl.value; paint(); };
        if (reasonEl) reasonEl.onchange = function () { reason = reasonEl.value; paint(); };
        $('.stk-more').onclick = function () {
          var t = $('.stk-note');
          t.hidden = !t.hidden;
          $('.stk-more').hidden = true;
          if (!t.hidden) t.focus();
        };
        $('.stk-note').oninput = function () { note = this.value; };
        var ctxX = $('.stk-ctx-x');
        if (ctxX) ctxX.onclick = function () { ctx = null; $('.stk-ctx').remove(); };

        goEl.onclick = async function () {
          errEl.hidden = true;
          var after = remainingAfter();
          if (mode === 'set' && !reason) { errEl.textContent = 'Pick a reason first.'; errEl.hidden = false; return; }
          // The one confirm in the flow, and only for the case that deserves it.
          if (after < 0 && !window.confirm(
                'That leaves ' + after + (unit ? ' ' + unit : '') +
                ' — less than nothing.\n\nRecord it anyway? A manager can correct it later.')) return;

          busy = true; paint();
          try {
            var res = mode === 'set'
              ? await Q.recount({ itemId: item.id, to: amount, reason: reason, note: note })
              : await Q.consume({
                  itemId: item.id, qty: amount, unit: chosenUnit, note: note,
                  purpose: opts.purpose || null, labelCode: opts.labelCode || null,
                  locId: opts.locId || null,
                  context: ctx ? { notebookEntryId: ctx.notebookEntryId || null } : null,
                });
            if (opts.onDone) { try { opts.onDone(res); } catch (e) { /* caller's problem */ } }
            showDone(body, api, res, mode);
          } catch (e) {
            busy = false; paint();
            errEl.textContent = friendly(e);
            errEl.hidden = false;
          }
        };

        paint();
        // Focus the field only when there are no chips — otherwise the keyboard
        // covers the chips that are meant to be the primary input.
        if (!presets.length) setTimeout(function () { nEl.focus(); nEl.select(); }, 60);
      },
    });
  }

  function friendly(e) {
    var m = (e && e.message) || String(e);
    if (/permission-denied|PERMISSION_DENIED/i.test(m)) {
      return 'You can record what you took, but only an inventory manager can raise a count.';
    }
    if (/not signed in/i.test(m)) return 'Sign in again and retry.';
    if (/no longer exists/i.test(m)) return 'That item was deleted while this was open.';
    return m;
  }

  /* Six seconds of Undo, then the sheet closes itself. Undo is a compensating
   * ledger row, so it needs manager rights to raise the count back — which is
   * why it is offered only when it will actually work. */
  function showDone(body, api, res, mode) {
    var u = res.unit ? ' ' + res.unit : '';
    var mayUndo = mode !== 'set' && canManage();
    body.innerHTML =
      '<div class="stk-done"><span>Recorded — <strong>' + res.after + u + '</strong> left</span>' +
      (mayUndo ? '<button type="button" class="stk-undo">Undo</button>' : '') + '</div>';
    if (typeof TOAST !== 'undefined' && TOAST.success) {
      TOAST.success('Recorded — ' + res.after + u + ' left');
    }
    var t = setTimeout(function () { api.close(); }, 6000);
    var btn = body.querySelector('.stk-undo');
    if (btn) btn.onclick = async function () {
      clearTimeout(t);
      btn.disabled = true; btn.textContent = 'Undoing…';
      try {
        var back = await window.INV_QTY.undo(res.usageId);
        if (typeof TOAST !== 'undefined' && TOAST.success) {
          TOAST.success('Put back — ' + back.after + u + ' left');
        }
      } catch (e) {
        if (typeof TOAST !== 'undefined' && TOAST.error) TOAST.error(friendly(e));
      }
      api.close();
    };
  }

  window.STOCK_TAKE = { open: open, canManage: canManage, detectContext: detectContext };
})();
