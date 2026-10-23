/* qty-picker.js — V3.840: "how much are you taking?" on the Woodchuck dial.
 *
 * Alex: "then it asks how much you are taking from inventory. each item has a
 * different selector unit. use the same radial selector for this that wodcuck
 * uses."
 *
 * Woodchuck is the gym app (MS/apps/gym); its js/picker.js is a bottom sheet
 * with a snapping DRUM WHEEL and a RADIAL JOG DIAL — turn the knob for fine
 * steps, ± buttons, a haptic tick per step. This is that picker, ported to RM
 * tokens, with the plate/stack loaders replaced by preset chips and an optional
 * extra block (a note field, a "finished this one" tick).
 *
 *   var r = await QTY_PICKER.open({ title: 'Anti-tubulin', unit: 'uL', max: 98, hint: '98 µL left' });
 *   r → { value: 2, extra: { note: '…', finished: false } } | null (cancelled)
 *
 * Units behave differently — a count (vials, packs, uses) is an integer drum
 * where the dial steps rows; a measure (µL, mL, g, …) is a 1/2/5 ladder across
 * the range (≤ ~400 rows) and the dial moves by a tenth of a rung, so 2.3 µL is
 * reachable without a 2 300-row wheel.
 *
 * QTY_PICKER_CORE (DOM-free, node-tested): niceStep, specFor, range, nearest,
 * fmt, displayUnit, defaultValue. */
(function (root) {
  'use strict';

  var COUNT_UNITS = ['ea', 'pack', 'box', 'vial', 'tube', 'plate', 'aliquot', 'slide', 'bottle', 'package', 'use', 'pkg', 'piece', 'unit'];
  var MEASURE_DEFAULT_MAX = { uL: 1000, mL: 100, L: 5, g: 100, mg: 1000, ug: 1000, kg: 5 };
  var DISPLAY = { uL: 'µL', ug: 'µg', package: 'package', use: 'use' };

  function num(v, d) { var n = typeof v === 'number' ? v : parseFloat(v); return isFinite(n) ? n : (d == null ? 0 : d); }
  function clean(n) { return Math.round(n * 1e6) / 1e6; }
  function fmt(v) { v = clean(num(v)); return Number(v.toFixed(3)).toString(); }
  function displayUnit(unit, n) {
    unit = unit || '';
    var d = DISPLAY[unit] || unit;
    if ((unit === 'package' || unit === 'use') && n != null && n !== 1) d += 's';
    return d;
  }
  function isCount(unit) { return !unit || COUNT_UNITS.indexOf(unit) >= 0; }

  /** 1 / 2 / 5 × 10^k, the smallest that keeps max/step within `rows` (400). */
  function niceStep(max, rows) {
    rows = rows || 400;
    if (!(max > 0)) return 1;
    var raw = max / rows;
    var k = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10));
    var m = [1, 2, 5, 10];
    for (var i = 0; i < m.length; i++) if (clean(m[i] * k) >= raw - 1e-12) return clean(m[i] * k);
    return clean(10 * k);
  }

  function range(lo, hi, step) {
    var out = [];
    if (!(step > 0)) return out;
    for (var v = lo, n = 0; v <= hi + 1e-9 && n < 5000; v = clean(v + step), n++) out.push(clean(v));
    return out;
  }

  function nearest(values, v) {
    if (!values || !values.length) return v;
    return values.reduce(function (a, b) { return Math.abs(b - v) < Math.abs(a - v) ? b : a; });
  }

  /**
   * specFor(unit, { max, min, step, fine, remaining, integer })
   *  → { unit, display, values, min, max, step, fine, integer }
   * counts: 1 … max (remaining, else 50), step 1, the dial steps rows (fine 0)
   * measures: min … max (remaining, else a unit default) on a nice ladder, fine = step / 10
   */
  function specFor(unit, opts) {
    opts = opts || {};
    unit = unit || 'ea';
    var integer = opts.integer != null ? !!opts.integer : isCount(unit);
    var rem = num(opts.remaining);
    var max, min, step, fine;
    if (integer) {
      max = opts.max != null ? Math.round(num(opts.max)) : (rem > 0 ? Math.round(rem) : 50);
      min = opts.min != null ? Math.max(0, Math.round(num(opts.min))) : 1;
      if (max < Math.max(min, 1)) max = Math.max(min, 1);
      step = 1; fine = 0;
    } else {
      max = opts.max != null ? num(opts.max) : (rem > 0 ? rem : (MEASURE_DEFAULT_MAX[unit] || 100));
      if (!(max > 0)) max = MEASURE_DEFAULT_MAX[unit] || 100;
      max = clean(max);
      step = opts.step > 0 ? clean(opts.step) : niceStep(max);
      min = opts.min != null ? Math.max(0, num(opts.min)) : 0;
      fine = opts.fine > 0 ? clean(opts.fine) : clean(step / 10);
    }
    var values = range(min, max, step);
    if (!values.length || values[values.length - 1] < max - 1e-9) values.push(clean(max));   // the top is always reachable
    return { unit: unit, display: displayUnit(unit), values: values, min: min, max: max, step: step, fine: fine, integer: integer };
  }

  /** Where the drum starts: the remembered value when it still fits, else 1 for a count, else a tenth of the range. */
  function defaultValue(spec, memo) {
    if (memo != null && memo > 0 && memo <= spec.max + 1e-9) return spec.integer ? Math.round(memo) : clean(memo);
    if (spec.integer) return Math.max(spec.min, 1) <= spec.max ? Math.max(spec.min, 1) : spec.max;
    return nearest(spec.values.filter(function (v) { return v > 0; }), spec.max / 10) || spec.values[spec.values.length - 1];
  }

  var CORE = { COUNT_UNITS, MEASURE_DEFAULT_MAX, niceStep, range, nearest, fmt, clean, num, displayUnit, isCount, specFor, defaultValue };
  if (typeof module !== 'undefined' && module.exports) module.exports = CORE;
  if (!root || typeof root.document === 'undefined') return;
  root.QTY_PICKER_CORE = CORE;

  /* ── the sheet ─────────────────────────────────────────────────────── */
  var MEMO_KEY = 'rm.qtyPicker.v1';
  function recall(memo) { try { return memo ? JSON.parse(localStorage.getItem(MEMO_KEY) || '{}')[memo] : null; } catch (e) { return null; } }
  function remember(memo, v) { if (!memo) return; try { var o = JSON.parse(localStorage.getItem(MEMO_KEY) || '{}'); o[memo] = v; localStorage.setItem(MEMO_KEY, JSON.stringify(o)); } catch (e) {} }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function tick() {
    try { if (navigator.vibrate) navigator.vibrate(3); } catch (e) {}
    try { var H = root.Capacitor && Capacitor.Plugins && Capacitor.Plugins.Haptics; if (H && H.impact) H.impact({ style: 'LIGHT' }); } catch (e) {}
  }

  var CSS =
    'body.qp-open{overflow:hidden}' +
    '.qp-bg{position:fixed;inset:0;z-index:9600;background:rgba(15,23,42,.45);display:flex;align-items:flex-end;justify-content:center;animation:qp-fade .15s ease-out}' +
    '@keyframes qp-fade{from{opacity:0}to{opacity:1}}' +
    '.qp-sheet{width:100%;max-width:560px;background:var(--card,#fff);color:var(--text,#0f172a);border-radius:18px 18px 0 0;padding:8px 14px calc(14px + env(safe-area-inset-bottom,0px));box-shadow:0 -8px 30px rgba(0,0,0,.25);animation:qp-up .2s ease-out;max-height:92vh;overflow-y:auto}' +
    '@keyframes qp-up{from{transform:translateY(40px)}to{transform:none}}' +
    '.qp-head{display:flex;align-items:center;justify-content:space-between}' +
    '.qp-head button{border:0;background:none;font-weight:700;font-size:15px;padding:10px 4px;cursor:pointer;color:var(--primary,#2563eb)}' +
    '.qp-head .qp-cancel{color:var(--text-muted,#64748b)}' +
    '.qp-head .qp-done:disabled{opacity:.4;cursor:default}' +
    '.qp-title{font-weight:700;font-size:14px;color:var(--text,#0f172a);text-align:center;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:0 6px}' +
    '.qp-readout{text-align:center;margin:2px 0 8px}' +
    '.qp-val{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:44px;font-weight:800;letter-spacing:-.03em;font-variant-numeric:tabular-nums}' +
    '.qp-unit{font-size:16px;color:var(--text-muted,#64748b);margin-left:6px;font-weight:600}' +
    '.qp-hint{font-size:12.5px;color:var(--text-muted,#64748b);min-height:1.2em}' +
    '.qp-presets{display:flex;gap:6px;flex-wrap:wrap;justify-content:center;margin:0 0 8px}' +
    '.qp-preset{min-width:46px;height:36px;padding:0 12px;border-radius:999px;border:1px solid var(--border,#e2e8f0);background:var(--bg,#f1f5f9);font-weight:700;font-size:13px;cursor:pointer;color:var(--text,#0f172a)}' +
    '.qp-preset.on{background:var(--primary,#2563eb);border-color:var(--primary,#2563eb);color:#fff}' +
    '.qp-extra{display:flex;flex-direction:column;gap:8px;margin:0 0 10px;font-size:14px}' +
    '.qp-extra input[type=text]{font-size:16px;padding:8px 10px;border:1px solid var(--border,#e2e8f0);border-radius:8px;background:var(--bg,#f1f5f9);color:var(--text,#0f172a);width:100%;box-sizing:border-box}' +
    '.qp-extra label{display:flex;align-items:center;gap:8px}' +
    '.qp-extra input[type=checkbox]{width:20px;height:20px}' +
    '.qp-controls{display:grid;grid-template-columns:1fr 200px;gap:10px;align-items:center}' +
    '@media (max-width:420px){.qp-controls{grid-template-columns:1fr 170px}}' +
    '.qp-drumwrap{position:relative;height:220px}' +
    '.qp-drum{height:100%;overflow-y:auto;scroll-snap-type:y mandatory;-webkit-overflow-scrolling:touch;scrollbar-width:none;mask-image:linear-gradient(transparent,#000 25%,#000 75%,transparent);-webkit-mask-image:linear-gradient(transparent,#000 25%,#000 75%,transparent)}' +
    '.qp-drum::-webkit-scrollbar{display:none}' +
    '.qp-pad{height:88px}' +
    '.qp-item{height:44px;display:flex;align-items:center;justify-content:center;scroll-snap-align:center;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:22px;color:var(--text-muted,#64748b);font-variant-numeric:tabular-nums}' +
    '.qp-item.on{color:var(--text,#0f172a);font-weight:800;font-size:26px}' +
    '.qp-drumline{position:absolute;left:10%;right:10%;top:88px;height:44px;border-top:2px solid var(--primary,#2563eb);border-bottom:2px solid var(--primary,#2563eb);pointer-events:none;border-radius:6px;opacity:.6}' +
    '.qp-dial{display:flex;flex-direction:column;align-items:center;gap:6px}' +
    '.qp-dial svg{width:100%;max-width:200px;touch-action:none;cursor:grab;display:block}' +
    '.qp-ring{fill:var(--bg,#f1f5f9);stroke:var(--border,#e2e8f0);stroke-width:26}' +
    '.qp-ticks line{stroke:var(--border,#cbd5e1);stroke-width:2}' +
    '.qp-knob{fill:var(--primary,#2563eb)}' +
    '.qp-dialtxt{fill:var(--text,#0f172a);font-size:15px;font-weight:700}.qp-dialtxt2{fill:var(--text-muted,#64748b);font-size:11px}' +
    '.qp-pm{display:flex;gap:8px}' +
    '.qp-pm button{width:56px;height:40px;border-radius:10px;border:1px solid var(--border,#e2e8f0);background:var(--bg,#f1f5f9);color:var(--text,#0f172a);font-size:22px;font-weight:700;cursor:pointer}' +
    '.qp-sheet,.qp-sheet *{-webkit-user-select:none;user-select:none}' +
    '.qp-extra input,.qp-extra textarea{-webkit-user-select:text;user-select:text}';

  var _sheet = null, _cur = null;
  function ensureCSS() {
    if (document.getElementById('qty-picker-css')) return;
    var s = document.createElement('style'); s.id = 'qty-picker-css'; s.textContent = CSS;
    document.head.appendChild(s);
  }

  function close(result) {
    if (_sheet) { _sheet.remove(); _sheet = null; }
    document.body.classList.remove('qp-open');
    var r = _cur; _cur = null;
    if (r) r(result === undefined ? null : result);
  }

  /**
   * open(opts) → Promise<{ value, extra } | null>
   * opts: title, unit, value, max, min, step, fine, remaining, integer, hint,
   *       presets[], extraHtml, doneLabel, memo, allowZero
   */
  function open(opts) {
    opts = opts || {};
    ensureCSS();
    return new Promise(function (resolve) {
      if (_sheet) close(null);
      var spec = specFor(opts.unit, opts);
      var memo = opts.memo ? recall(opts.memo) : null;
      var cur = opts.value != null && opts.value > 0 ? clean(num(opts.value)) : defaultValue(spec, memo);
      if (spec.integer) cur = nearest(spec.values, cur);
      cur = Math.min(spec.max, Math.max(spec.min, cur));
      var presets = (opts.presets || []).map(function (v) { return clean(num(v)); }).filter(function (v) { return v > 0 && v <= spec.max + 1e-9; });

      var sheet = document.createElement('div');
      sheet.className = 'qp-bg';
      var ticks = '';
      for (var i = 0; i < 24; i++) { var a = i * 15 * Math.PI / 180; ticks += '<line x1="' + (100 + 70 * Math.sin(a)).toFixed(1) + '" y1="' + (100 - 70 * Math.cos(a)).toFixed(1) + '" x2="' + (100 + 76 * Math.sin(a)).toFixed(1) + '" y2="' + (100 - 76 * Math.cos(a)).toFixed(1) + '"/>'; }
      sheet.innerHTML =
        '<div class="qp-sheet" role="dialog" aria-modal="true" aria-label="' + esc(opts.title || 'How much') + '">' +
          '<div class="qp-head"><button type="button" class="qp-cancel">Cancel</button><div class="qp-title">' + esc(opts.title || '') + '</div><button type="button" class="qp-done">' + esc(opts.doneLabel || 'Done') + '</button></div>' +
          '<div class="qp-readout"><span class="qp-val"></span><span class="qp-unit"></span><div class="qp-hint">' + esc(opts.hint || '') + '</div></div>' +
          (presets.length ? '<div class="qp-presets">' + presets.map(function (v) { return '<button type="button" class="qp-preset" data-v="' + v + '">' + esc(fmt(v)) + '</button>'; }).join('') + '</div>' : '') +
          (opts.extraHtml ? '<div class="qp-extra">' + opts.extraHtml + '</div>' : '') +
          '<div class="qp-controls">' +
            '<div class="qp-drumwrap"><div class="qp-drum"></div><div class="qp-drumline"></div></div>' +
            '<div class="qp-dial">' +
              '<svg viewBox="0 0 200 200" aria-label="Fine adjust dial"><circle class="qp-ring" cx="100" cy="100" r="82"/><g class="qp-ticks">' + ticks + '</g><circle class="qp-knob" cx="100" cy="18" r="13"/><text class="qp-dialtxt" x="100" y="94" text-anchor="middle">turn</text><text class="qp-dialtxt2" x="100" y="116" text-anchor="middle">' + (spec.fine ? 'fine ' + esc(fmt(spec.fine)) : 'one at a time') + '</text></svg>' +
              '<div class="qp-pm"><button type="button" class="qp-minus" aria-label="Less">−</button><button type="button" class="qp-plus" aria-label="More">+</button></div>' +
            '</div>' +
          '</div>' +
        '</div>';
      document.body.appendChild(sheet);
      document.body.classList.add('qp-open');
      _sheet = sheet; _cur = resolve;

      var $ = function (q) { return sheet.querySelector(q); };
      var drum = $('.qp-drum'), valEl = $('.qp-val'), unitEl = $('.qp-unit'), knob = $('.qp-knob'), doneBtn = $('.qp-done');
      var ITEM = 44;
      drum.innerHTML = '<div class="qp-pad"></div>' + spec.values.map(function (v) { return '<div class="qp-item">' + esc(fmt(v)) + '</div>'; }).join('') + '<div class="qp-pad"></div>';
      var suppress = false;
      var idxOf = function (v) { var i = spec.values.indexOf(v); return i >= 0 ? i : spec.values.indexOf(nearest(spec.values, v)); };
      var items = drum.querySelectorAll('.qp-item');

      function paint() {
        valEl.textContent = fmt(cur);
        unitEl.textContent = displayUnit(spec.unit, cur);
        var near = nearest(spec.values, cur);
        for (var i = 0; i < items.length; i++) items[i].classList.toggle('on', spec.values[i] === near && Math.abs(near - cur) < 1e-9);
        var chips = sheet.querySelectorAll('.qp-preset');
        for (var j = 0; j < chips.length; j++) chips[j].classList.toggle('on', Math.abs(num(chips[j].getAttribute('data-v')) - cur) < 1e-9);
        doneBtn.disabled = !(cur > 0 || opts.allowZero);
      }
      function render(fromDrum) {
        paint();
        if (!fromDrum) { suppress = true; drum.scrollTop = idxOf(cur) * ITEM; requestAnimationFrame(function () { suppress = false; }); }
      }
      function setCur(v, fromDrum) {
        v = clean(num(v));
        if (spec.integer) v = nearest(spec.values, v);
        cur = Math.min(spec.max, Math.max(spec.min, v));
        render(fromDrum);
      }
      function stepRows(n) { var i = Math.max(0, Math.min(spec.values.length - 1, idxOf(cur) + n)); setCur(spec.values[i]); }
      function fineStep(n) {
        if (spec.fine) { cur = clean(Math.min(spec.max, Math.max(spec.min, cur + n * spec.fine))); paint(); }
        else stepRows(n);
        tick();
      }

      // drum scroll → value
      var scrollT;
      drum.addEventListener('scroll', function () {
        if (suppress) return;
        clearTimeout(scrollT);
        var i = Math.round(drum.scrollTop / ITEM);
        var v = spec.values[Math.max(0, Math.min(spec.values.length - 1, i))];
        if (v !== cur) { cur = v; paint(); }
        scrollT = setTimeout(function () { drum.scrollTo({ top: idxOf(cur) * ITEM, behavior: 'smooth' }); }, 120);
      }, { passive: true });

      // dial rotation → steps (15° per row, 6° per fine step — Woodchuck's numbers)
      var dragging = false, lastAngle = 0, acc = 0, rot = 0;
      var svg = $('.qp-dial svg');
      var angleAt = function (ev) { var r = svg.getBoundingClientRect(); return Math.atan2(ev.clientY - (r.top + r.height / 2), ev.clientX - (r.left + r.width / 2)) * 180 / Math.PI; };
      svg.addEventListener('pointerdown', function (ev) { dragging = true; lastAngle = angleAt(ev); acc = 0; try { svg.setPointerCapture(ev.pointerId); } catch (e) {} ev.preventDefault(); });
      svg.addEventListener('pointermove', function (ev) {
        if (!dragging) return;
        var a = angleAt(ev); var d = a - lastAngle; if (d > 180) d -= 360; if (d < -180) d += 360;
        lastAngle = a; acc += d; rot += d;
        knob.setAttribute('transform', 'rotate(' + rot + ' 100 100)');
        var per = spec.fine ? 6 : 15;
        while (acc >= per) { acc -= per; fineStep(1); }
        while (acc <= -per) { acc += per; fineStep(-1); }
      });
      var endDrag = function () { dragging = false; };
      svg.addEventListener('pointerup', endDrag); svg.addEventListener('pointercancel', endDrag);
      $('.qp-minus').onclick = function () { fineStep(-1); };
      $('.qp-plus').onclick = function () { fineStep(1); };
      sheet.querySelectorAll('.qp-preset').forEach(function (b) { b.onclick = function () { setCur(num(b.getAttribute('data-v'))); tick(); }; });

      function extra() {
        var out = {};
        sheet.querySelectorAll('.qp-extra [name]').forEach(function (el) {
          out[el.getAttribute('name')] = el.type === 'checkbox' ? !!el.checked : (el.value || '');
        });
        return out;
      }
      $('.qp-cancel').onclick = function () { close(null); };
      doneBtn.onclick = function () {
        if (doneBtn.disabled) return;
        if (opts.memo) remember(opts.memo, cur);
        close({ value: clean(cur), unit: spec.unit, extra: extra() });
      };
      sheet.addEventListener('click', function (ev) { if (ev.target === sheet) close(null); });
      render(false);
    });
  }

  root.QTY_PICKER = { open: open, close: function () { close(null); }, isOpen: function () { return !!_sheet; }, core: CORE };
})(typeof window !== 'undefined' ? window : null);
