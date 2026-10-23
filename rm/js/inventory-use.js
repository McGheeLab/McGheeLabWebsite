/* inventory-use.js — V3.834: "use the item" from a scan, two ways.
 * V3.840: the amount is asked on the Woodchuck dial (qty-picker.js), in the
 * item's own unit, and a measured per-use amount moves the measure.
 *
 * Alex: "some items need to be scanned per use like antibodies, matrigel, and
 * others that we designate. Other items should be replaced as a package like
 * conical tubes, pipette tips etc." — and (V3.840) "we need a button to scan
 * a qr code, then it asks how much you are taking from inventory. each item
 * has a different selector unit."
 *
 * use_mode on the item (a manager designates it; firestore.rules keeps it in
 * qtyControlsUnchanged so a member cannot flip it):
 *   per_use  — one scan = one USE. Tracked in a measure (µL, mL, g…) the dial
 *              asks how much and that amount comes off through the V3.646
 *              ledger, with use_count + 1. Otherwise a ledger row (event 'use',
 *              unit 'use', delta 0) and use_count on the item; the count of
 *              vials only drops when someone ticks "Finished this one".
 *   package  — one scan = packages gone. A tracked item goes through
 *              INV_QTY.consume (low-stock alerts included); an untracked item
 *              decrements the legacy `quantity` scalar and still writes a
 *              ledger row, so nothing is silently lost.
 *   (none)   — a consumable defaults to package; anything else asks.
 *
 * plan() and pickerFor() are pure and node-tested; run() performs a plan;
 * take() is the scan flow (mode → dial → plan → run → toast); sheet() is kept
 * as its alias for V3.835 callers. */
(function (root) {
  'use strict';

  var MODES = {
    per_use: { label: 'Scan per use', verb: 'I used it', hint: 'antibodies, Matrigel, enzymes — one scan logs one use; the vial count only drops when you say it is finished' },
    package: { label: 'Replace as a package', verb: 'I took a package', hint: 'tubes, tips, gloves — one scan takes one package off the shelf' },
  };
  var MEASURE_UNITS = ['uL', 'mL', 'L', 'ug', 'mg', 'g', 'kg'];

  function num(v, d) { var n = typeof v === 'number' ? v : parseFloat(v); return isFinite(n) ? n : (d == null ? 0 : d); }
  function clean(n) { return Math.round(n * 1e6) / 1e6; }
  function isTracked(item) { return !!(item && item.qty_tracked); }
  function isMeasure(unit) { return MEASURE_UNITS.indexOf(unit) >= 0; }
  function fmtN(v) { return Number(clean(num(v)).toFixed(3)).toString(); }
  var COUNT_PLURAL = { pack: 'packs', box: 'boxes', vial: 'vials', tube: 'tubes', plate: 'plates', aliquot: 'aliquots', slide: 'slides', bottle: 'bottles', piece: 'pieces', package: 'packages', use: 'uses' };
  function unitWord(unit, n) {
    if (unit === 'uL') return 'µL';
    if (unit === 'ug') return 'µg';
    return (n !== 1 && COUNT_PLURAL[unit]) || unit || '';
  }

  function modeOf(item) {
    if (!item) return '';
    if (item.use_mode === 'per_use' || item.use_mode === 'package') return item.use_mode;
    return item.is_consumable ? 'package' : '';
  }

  /** Reorder point: explicit qty_min, else 20% of qty_made (the V3.646 rule); untracked: 1. */
  function lowAt(item) {
    if (!isTracked(item)) return 1;
    if (item.qty_min != null && item.qty_min !== '') return num(item.qty_min);
    return clean(num(item.qty_made) * 0.2);
  }

  /**
   * What a scan should do. action: { kind: 'use' | 'take' | 'finish', n }
   *   → { via: 'log' | 'qty' | 'legacy', event, qty, unit, delta, before, after, itemPatch, low, last, mode }
   * 'use'    (per_use)  log only — unless the item is tracked in a MEASURE and an
   *                     amount n was given: then n comes off the measure and one use is counted.
   * 'take'   (package)  n packages off: ledger via INV_QTY when tracked, legacy quantity otherwise.
   *                     n may be fractional only when the item's unit is a measure.
   * 'finish' (per_use)  the vial is empty — a count takes one unit off; a measure takes all that is left.
   */
  function plan(item, action) {
    action = action || {};
    var mode = modeOf(item);
    var tracked = isTracked(item);
    var unit = tracked ? (item.qty_unit || 'ea') : 'ea';
    var measure = tracked && isMeasure(unit);
    var raw = num(action.n, 1);
    var n = measure ? Math.max(0, clean(raw)) : Math.max(1, Math.round(raw));
    var q = clean(num(item.qty_remaining));
    var legacy = clean(num(item.quantity));
    var uses = Math.max(0, Math.round(num(item.use_count)));
    if (action.kind === 'use') {
      if (measure && action.n != null && n > 0) {
        var afterU = clean(q - n);
        return { via: 'qty', mode: mode || 'per_use', event: 'use', qty: n, unit: unit, delta: -n, before: q, after: afterU,
                 itemPatch: { use_count: uses + 1 }, low: afterU <= lowAt(item), last: afterU <= 0 };
      }
      var k = Math.max(1, Math.round(raw));
      var before = tracked ? q : legacy;
      return { via: 'log', mode: mode || 'per_use', event: 'use', qty: k, unit: 'use', delta: 0, before: before, after: before,
               itemPatch: { use_count: uses + k }, low: false, last: false };
    }
    if (action.kind === 'finish' && measure) {
      if (q <= 0) {
        return { via: 'log', mode: mode || 'per_use', event: 'use', qty: 1, unit: 'use', delta: 0, before: q, after: q,
                 itemPatch: { use_count: 0 }, low: true, last: true };
      }
      n = q;
    }
    if (tracked) {
      var after = clean(q - n);
      return { via: 'qty', mode: mode || 'package', event: 'use', qty: n, unit: unit, delta: -n, before: q, after: after,
               itemPatch: action.kind === 'finish' ? { use_count: 0 } : {}, low: after <= lowAt(item), last: after <= 0 };
    }
    var afterL = Math.max(0, clean(legacy - n));
    return { via: 'legacy', mode: mode || 'package', event: 'use', qty: n, unit: unit, delta: clean(afterL - legacy), before: legacy, after: afterL,
             itemPatch: Object.assign({ quantity: afterL }, action.kind === 'finish' ? { use_count: 0 } : {}), low: afterL <= 1, last: afterL <= 0 };
  }

  /**
   * The dial's unit and range for this item — "each item has a different
   * selector unit".  → { kind, unit, max, integer, remaining, question, finish }
   *   package · tracked count (pack, box, ea…)  → that unit, 1 … remaining
   *   package · tracked measure                → that unit, fractional, up to remaining
   *   package · untracked                      → 'package', 1 … 50 (or the legacy Qty)
   *   per_use · tracked measure (µL, mL, g…)   → that unit, fractional, up to remaining; a "finished" tick
   *   per_use · anything else                  → 'use', 1 … 20; a "finished" tick
   */
  function pickerFor(item, mode) {
    item = item || {};
    mode = mode || modeOf(item) || 'package';
    var tracked = isTracked(item);
    var unit = tracked ? (item.qty_unit || 'ea') : '';
    var rem = clean(num(item.qty_remaining));
    var legacy = clean(num(item.quantity));
    if (mode === 'package') {
      if (tracked && isMeasure(unit)) return { kind: 'take', unit: unit, max: rem > 0 ? rem : null, integer: false, remaining: rem, question: 'How much are you taking?', finish: false };
      if (tracked) return { kind: 'take', unit: unit, max: Math.max(1, Math.round(rem)), integer: true, remaining: rem, question: 'How many are you taking?', finish: false };
      return { kind: 'take', unit: 'package', max: legacy > 0 ? Math.max(1, Math.round(legacy)) : 50, integer: true, remaining: legacy, question: 'How many packages?', finish: false };
    }
    if (tracked && isMeasure(unit)) return { kind: 'use', unit: unit, max: rem > 0 ? rem : null, integer: false, remaining: rem, question: 'How much are you taking?', finish: true };
    return { kind: 'use', unit: 'use', max: 20, integer: true, remaining: tracked ? rem : legacy, question: 'How many uses?', finish: true };
  }

  /** The line a toast says after a plan ran. */
  function describe(res) {
    var p = res.plan, it = res.item || {};
    var name = it.name ? ' of ' + it.name : '';
    var u = p.unit === 'ea' && p.via === 'legacy' ? 'package' : p.unit;
    var msg;
    if (p.via === 'log') msg = 'Logged ' + p.qty + ' use' + (p.qty === 1 ? '' : 's') + name + '.';
    else if (res.finished) msg = 'Finished — took it off the shelf.';
    else msg = (p.mode === 'per_use' ? 'Used ' : 'Took ') + fmtN(p.qty) + ' ' + unitWord(u, p.qty) + name + '.';
    var left = res.after != null ? res.after : p.after;
    if (p.via !== 'log') msg += ' ' + fmtN(left) + ' ' + unitWord(u, left) + ' left.';
    if (res.last) msg += ' That was the last one.'; else if (res.low) msg += ' Running low.';
    return msg;
  }

  var CORE = { MODES, MEASURE_UNITS, modeOf, plan, pickerFor, describe, lowAt, isTracked, isMeasure, num, fmtN, unitWord };
  if (typeof module !== 'undefined' && module.exports) module.exports = CORE;
  if (!root || typeof root.document === 'undefined') return;
  root.INV_USE_CORE = CORE;

  /* ── page half ─────────────────────────────────────────────────────── */
  function db() { return (typeof firebridge !== 'undefined' && firebridge.db) ? firebridge.db() : firebase.firestore(); }
  function me() { return (typeof firebridge !== 'undefined' && firebridge.getUser) ? firebridge.getUser() : (firebase.auth && firebase.auth().currentUser); }
  function profile() { try { return (typeof firebridge !== 'undefined' && firebridge.getProfile) ? firebridge.getProfile() : null; } catch (e) { return null; } }
  function ts() { return firebase.firestore.FieldValue.serverTimestamp(); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function toast(msg, kind, opts) { if (root.TOAST) { (kind === 'error' ? TOAST.error : TOAST.success)(msg, opts); } }
  function canManage() { return !!(root.STOCK_TAKE && STOCK_TAKE.canManage && STOCK_TAKE.canManage()); }
  function reorderHref(item) { return '/rm/pages/procurement.html?reorder=' + encodeURIComponent(item.id); }
  function goReorder(item) {
    var href = reorderHref(item);
    try { var T = root.Capacitor && Capacitor.isNativePlatform && Capacitor.isNativePlatform() && Capacitor.Plugins && Capacitor.Plugins.OurlabTabs; if (T) { T.open({ href: href }).catch(function () { location.href = href; }); return; } } catch (e) {}
    location.href = href;
  }

  /**
   * Perform a plan. opts: { labelCode, note, context }
   * Resolves { item (merged), plan, usageId, low, last, after }.
   */
  async function run(item, p, opts) {
    opts = opts || {};
    var user = me(); if (!user) throw new Error('Sign in first.');
    if (p.via === 'qty') {
      var res = await INV_QTY.consume({ itemId: item.id, qty: p.qty, unit: p.unit, labelCode: opts.labelCode || null,
        note: opts.note || '', context: opts.context || 'scan', itemPatch: Object.assign({ use_mode: modeOf(item) || undefined }, p.itemPatch) });
      return { item: res.item, plan: p, usageId: res.usageId, low: res.status === 'low' || res.status === 'out_of_stock', last: res.after <= 0, after: res.after };
    }
    // 'log' and 'legacy' — one transaction: the item's own numbers are read on
    // the server so before/after are true at write time, then one ledger row.
    var d = db();
    var itemRef = d.collection('inventory').doc(item.id);
    var usageRef = d.collection('inventoryUsage').doc();
    var prof = profile();
    var out = null;
    await d.runTransaction(async function (t) {
      var snap = await t.get(itemRef);
      if (!snap.exists) throw new Error('That item no longer exists.');
      var live = Object.assign({ id: item.id }, snap.data());
      var fresh = plan(live, { kind: p.via === 'log' ? 'use' : 'take', n: p.qty });
      if (p.itemPatch && p.itemPatch.use_count === 0) fresh.itemPatch.use_count = 0;   // a 'finish' keeps its reset
      var patch = Object.assign({}, fresh.itemPatch, { last_used_at: ts(), last_used_by: user.uid, updatedAt: ts() });
      t.update(itemRef, patch);
      t.set(usageRef, {
        itemId: item.id, itemKind: live.kind || 'item', itemName: live.name || '',
        event: 'use', qty: fresh.qty, delta: fresh.delta, unit: fresh.unit, before: fresh.before, after: fresh.after,
        useMode: fresh.mode, legacy: p.via === 'legacy', locId: null, labelCode: opts.labelCode || null,
        purpose: null, note: opts.note || '', reason: null, context: opts.context || 'scan', undoes: null,
        userUid: user.uid, userName: user.displayName || user.email || '', userInitials: (prof && prof.initials) || '',
        overrideBy: null, createdAt: ts(),
      });
      out = { item: Object.assign({}, live, patch, { last_used_at: new Date().toISOString() }), plan: fresh, usageId: usageRef.id, low: fresh.low, last: fresh.last, after: fresh.after };
    });
    try { if (typeof api !== 'undefined' && api.invalidate && root.INV_QTY) await api.invalidate(INV_QTY.routeFor(out.item)); } catch (e) {}
    // V3.844 — an action for the person (the qty route is recorded by INV_QTY.onLocalWrite)
    try {
      if (root.USER_ACTIONS) USER_ACTIONS.record(USER_ACTIONS.fromInventory({ itemId: item.id, usageId: out.usageId, qty: out.plan.qty, unit: out.plan.unit, delta: out.plan.delta, after: out.plan.after,
        note: opts.note || '', labelCode: opts.labelCode || null, context: opts.context || 'scan', useMode: out.plan.mode, legacy: p.via === 'legacy', item: out.item })).catch(function () {});
    } catch (e) {}
    return out;
  }

  /** A manager designates the mode. */
  async function setMode(item, mode) {
    if (mode !== 'per_use' && mode !== 'package' && mode !== '') throw new Error('unknown mode');
    await db().collection('inventory').doc(item.id).update({ use_mode: mode, updatedAt: ts() });
    item.use_mode = mode;
    try { if (typeof api !== 'undefined' && api.invalidate && root.INV_QTY) await api.invalidate(INV_QTY.routeFor(item)); } catch (e) {}
    return mode;
  }

  /** Mode unknown: ask once (a manager's answer is written; a member's is for this time), then continue. */
  function askMode(item, opts, then) {
    if (!root.APP_SHEET) { toast('The app sheet is not loaded.', 'error'); return; }
    var mgr = canManage();
    APP_SHEET.open({
      title: item.name || 'Item',
      build: function (body, api) {
        body.innerHTML =
          '<div class="iu-wrap">' +
            (opts.labelCode ? '<div class="iu-code">' + esc(opts.labelCode) + '</div>' : '') +
            '<div class="iu-meta">' + esc([item.vendor, item.catalogue_number].filter(Boolean).join(' · ')) + '</div>' +
            '<div class="iu-pick"><div class="iu-hint">How is this item used? ' + (mgr ? 'Pick once — it is remembered.' : 'A manager has not set this yet; pick for this time.') + '</div>' +
              '<button class="btn iu-mode-btn" data-iu-mode="per_use">' + esc(MODES.per_use.label) + '<small>' + esc(MODES.per_use.hint) + '</small></button>' +
              '<button class="btn iu-mode-btn" data-iu-mode="package">' + esc(MODES.package.label) + '<small>' + esc(MODES.package.hint) + '</small></button>' +
            '</div><div class="iu-status"></div></div>';
        body.addEventListener('click', async function (e) {
          var b = e.target.closest('[data-iu-mode]'); if (!b) return;
          var chosen = b.getAttribute('data-iu-mode');
          if (mgr) { try { await setMode(item, chosen); toast('Set to “' + MODES[chosen].label + '”'); } catch (err) { body.querySelector('.iu-status').textContent = err.message || 'Could not save the mode.'; return; } }
          else item.use_mode = chosen;   // this time only — not written
          try { api.close(); } catch (e2) {}
          then(chosen);
        });
      },
    });
  }

  /**
   * The flow: scan → (mode once) → the dial asks how much, in the item's unit →
   * plan → run → toast. opts: { labelCode, context, onDone }. Resolves the last
   * run result, or null when nothing was recorded.
   */
  function take(item, opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var mode = modeOf(item);
      if (!mode) { askMode(item, opts, function () { take(item, opts).then(resolve); }); return; }
      if (!root.QTY_PICKER) { _formSheet(item, opts); resolve(null); return; }
      var spec = pickerFor(item, mode);
      var tracked = isTracked(item);
      var left = tracked ? (root.INV_QTY ? INV_QTY.summary(item) : fmtN(spec.remaining) + ' ' + unitWord(spec.unit, 2) + ' left')
        : (item.quantity != null && item.quantity !== '' ? String(item.quantity) + ' on hand (not tracked)' : 'quantity not tracked');
      var presets = tracked && root.INV_QTY ? INV_QTY.presets(item) : [1, 2, 3, 5];
      var extra = '<input type="text" name="note" placeholder="Note — which experiment (optional)" autocomplete="off">' +
        (spec.finish ? '<label><input type="checkbox" name="finished"> Finished this one — take it off the shelf</label>' : '');
      QTY_PICKER.open({
        title: item.name || 'Item', unit: spec.unit, max: spec.max, remaining: spec.remaining, integer: spec.integer,
        hint: spec.question + ' · ' + left, presets: presets, extraHtml: extra, memo: 'inv:' + item.id,
        doneLabel: mode === 'package' ? 'Take' : 'Use', allowZero: !!spec.finish,
      }).then(async function (r) {
        if (!r) { resolve(null); return; }
        var finished = !!(r.extra && r.extra.finished);
        var note = (r.extra && r.extra.note) || '';
        var ctx = { labelCode: opts.labelCode || null, note: note, context: opts.context || 'scan' };
        var last = null;
        try {
          if (r.value > 0) {
            last = await run(item, plan(item, { kind: spec.kind, n: r.value }), ctx);
            Object.assign(item, last.item);
          }
          if (finished) {
            last = await run(item, plan(item, { kind: 'finish' }), ctx);
            last.finished = true;
            Object.assign(item, last.item);
          }
          if (!last) { toast('Nothing recorded — pick an amount.', 'error'); resolve(null); return; }
          var msg = describe(last);
          if (last.low || last.last) toast(msg, 'success', { actionLabel: 'Request a reorder', retry: function () { goReorder(item); }, ttl: 9000 });
          else toast(msg);
          if (opts.onDone) { try { opts.onDone(last); } catch (e) {} }
          resolve(last);
        } catch (err) {
          toast(/permission-denied/i.test(err.message || '') ? 'Not allowed — sign in with your lab account, or ask a manager.' : (err.message || 'Could not save.'), 'error');
          resolve(null);
        }
      });
    });
  }

  /** V3.835 form (number box) — only when qty-picker.js is not on the page. */
  function _formSheet(item, opts) {
    opts = opts || {};
    if (!root.APP_SHEET) { toast('The app sheet is not loaded.', 'error'); return; }
    var mgr = canManage();
    APP_SHEET.open({
      title: item.name || 'Item',
      build: function (body, api) {
        var tracked = isTracked(item);
        var left = tracked ? (root.INV_QTY ? INV_QTY.summary(item) : String(item.qty_remaining)) : (item.quantity != null && item.quantity !== '' ? String(item.quantity) + ' (not tracked)' : 'quantity not tracked');
        var m = modeOf(item);
        var main = m === 'per_use'
          ? '<div class="iu-row"><button class="btn btn-primary iu-go" data-iu-act="use">✓ ' + esc(MODES.per_use.verb) + '</button><span class="iu-sub">uses so far: ' + esc(String(Math.max(0, Math.round(num(item.use_count))))) + '</span></div>' +
            '<div class="iu-row"><button class="btn iu-finish" data-iu-act="finish">Finished this one — take 1 off the shelf</button></div>'
          : '<div class="iu-row"><label class="iu-n">Packages <input type="number" min="1" step="1" value="1" class="iu-count" inputmode="numeric"></label><button class="btn btn-primary iu-go" data-iu-act="take">✓ ' + esc(MODES.package.verb) + '</button></div>';
        body.innerHTML = '<div class="iu-wrap">' + (opts.labelCode ? '<div class="iu-code">' + esc(opts.labelCode) + '</div>' : '') +
          '<div class="iu-meta">' + esc([item.vendor, item.catalogue_number].filter(Boolean).join(' · ')) + '</div>' +
          '<div class="iu-left">On hand: <strong>' + esc(left) + '</strong>' + (m ? ' · <span class="iu-mode">' + esc(MODES[m].label) + '</span>' : '') + '</div>' + main +
          '<label class="iu-note">Note (optional) <input type="text" class="iu-note-in" placeholder="which experiment, which project"></label><div class="iu-status"></div>' +
          (mgr && m ? '<div class="iu-admin"><button class="btn btn-sm" data-iu-mode="' + (m === 'per_use' ? 'package' : 'per_use') + '">Switch to “' + esc(MODES[m === 'per_use' ? 'package' : 'per_use'].label) + '”</button></div>' : '') + '</div>';
        body.addEventListener('click', async function (e) {
          var modeBtn = e.target.closest('[data-iu-mode]');
          if (modeBtn) { try { await setMode(item, modeBtn.getAttribute('data-iu-mode')); api.close(); _formSheet(item, opts); } catch (err) { toast(err.message || 'Could not save the mode.', 'error'); } return; }
          var act = e.target.closest('[data-iu-act]'); if (!act) return;
          var kind = act.getAttribute('data-iu-act');
          var cnt = body.querySelector('.iu-count');
          var n = cnt ? Math.max(1, Math.round(num(cnt.value, 1))) : 1;
          var note = (body.querySelector('.iu-note-in') || {}).value || '';
          var st = body.querySelector('.iu-status');
          act.disabled = true; st.textContent = 'Saving…'; st.className = 'iu-status';
          try {
            var res = await run(item, plan(item, { kind: kind, n: n }), { labelCode: opts.labelCode || null, note: note, context: opts.context || 'scan' });
            Object.assign(item, res.item);
            var msg = describe(res);
            st.innerHTML = '<span class="iu-ok">' + esc(msg) + '</span>' + ((res.low || res.last) ? ' <a class="iu-reorder" href="' + reorderHref(item) + '">Request a reorder →</a>' : '');
            toast(msg);
            if (opts.onDone) { try { opts.onDone(res); } catch (err) {} }
            setTimeout(function () { try { api.close(); } catch (e2) {} }, 1600);
          } catch (err) {
            act.disabled = false;
            st.textContent = /permission-denied/i.test(err.message || '') ? 'Not allowed — sign in with your lab account, or ask a manager.' : (err.message || 'Could not save.');
            st.className = 'iu-status iu-err';
          }
        });
      },
    });
  }

  // styles once
  (function () {
    if (document.getElementById('inv-use-css')) return;
    var s = document.createElement('style'); s.id = 'inv-use-css';
    s.textContent = '.iu-wrap{display:flex;flex-direction:column;gap:10px;font-size:14px}.iu-code{font-family:ui-monospace,Menlo,monospace;font-size:12px;color:#4f46e5}.iu-meta{color:#64748b;font-size:12px}.iu-left{font-size:13px}.iu-mode{color:#4f46e5}.iu-pick{display:flex;flex-direction:column;gap:8px}.iu-hint{font-size:12px;color:#64748b;width:100%}.iu-mode-btn{display:flex;flex-direction:column;align-items:flex-start;gap:2px;text-align:left;min-height:56px;padding:10px 12px;font-weight:600}.iu-mode-btn small{font-weight:400;font-size:12px;color:#64748b;white-space:normal}.iu-row{display:flex;flex-wrap:wrap;gap:10px;align-items:center}.iu-go{min-height:44px;font-size:15px;font-weight:600}.iu-n{display:flex;align-items:center;gap:6px;font-size:13px}.iu-count{width:72px;font-size:16px;padding:6px 8px;border:1px solid #d1d5db;border-radius:8px}.iu-sub{font-size:12px;color:#64748b}.iu-note{display:flex;flex-direction:column;gap:4px;font-size:12px;color:#64748b}.iu-note-in{font-size:16px;padding:8px;border:1px solid #d1d5db;border-radius:8px}.iu-status{font-size:13px;min-height:18px}.iu-ok{color:#15803d;font-weight:600}.iu-err{color:#b91c1c}.iu-reorder{color:#4f46e5;font-weight:600;text-decoration:none;margin-left:6px}.iu-admin{border-top:1px dashed #e5e7eb;padding-top:8px}';
    document.head.appendChild(s);
  })();

  root.INV_USE = { MODES, modeOf, plan, pickerFor, describe, run, setMode, take, sheet: take, askMode, core: CORE };
})(typeof window !== 'undefined' ? window : null);
