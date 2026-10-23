/* inventory-made.js — V3.875: custom inventory (an aliquot, a material, a
 * medium) made in the lab, and what it was made from.
 *
 * Alex: "the what is it dropdown should be: custom alliquot, custom material,
 * custom media / for how many, we need units dropdown / … a user could make 4
 * 15mL tubes of LLS these should all be placed in the same location / we
 * should be able to consume something in the inventory to make an alliquot …
 * Be careful about consumption since some things we have qr codes for packs of
 * items, but here the user may mark down 4 15mL tubes were consumed, that
 * should not mean 4 packs of 15 mL tubes."
 *
 * THE RULE THAT MATTERS: planIngredient() subtracts only an amount that is
 * exact in the unit the inventory counts the item in (qty_unit). Single tubes
 * out of a pack, 7 mL out of a 15 mL tube, mL against a vial count, anything
 * nobody counts: NOTED (a delta-0 ledger row), never converted by guess.
 * unitChoices() lists the safe choice first, so the default can never
 * over-subtract. The case table is in CodeLog/ClaudesPlan/V3.875_*.md.
 *
 * A GROUP ("4 × 15 mL tubes") is one item at one location counted in its
 * container (qty_unit 'tube', qty_made 4) with each_amount/each_unit, and the
 * same QR code on every tube.
 *
 * INV_MADE_CORE is DOM-free and node-tested (scripts/tests/inventory-made.test.mjs);
 * INV_MADE.open() is the form, opened by inventory.js addLabMadeItem(). */
(function (root) {
  'use strict';

  var TYPES = { aliquot: 'Custom aliquot', material: 'Custom material', media: 'Custom media' };
  var TYPE_ORDER = ['aliquot', 'material', 'media'];
  var LEGACY_TYPES = { made_in_lab: 'material' };   // V3.873's second kind
  var START_UNIT = { aliquot: 'tube', material: 'tube', media: 'bottle' };
  // What a batch is counted in: containers first, then measures (no container).
  var CONTAINERS = ['tube', 'vial', 'aliquot', 'bottle', 'plate', 'slide', 'box', 'ea'];
  var MEASURES = ['uL', 'mL', 'L', 'mg', 'g'];
  // The same convertible families as INV_QTY (inventory-qty.js); kept here so
  // the core runs in node without a window.
  var FAMILIES = { volume: { uL: 0.001, mL: 1, L: 1000 }, mass: { ug: 0.001, mg: 1, g: 1000, kg: 1000000 } };
  // Counted units that hold many pieces, or might ('ea' is often a pack).
  var MULTI = ['pack', 'box', 'ea'];
  var PLURAL = { tube: 'tubes', vial: 'vials', aliquot: 'aliquots', bottle: 'bottles', plate: 'plates', slide: 'slides',
                 box: 'boxes', pack: 'packs', piece: 'pieces', package: 'packages' };
  var MAX_LABELS = 100;
  var SEARCH_LIMIT = 8;

  function num(v, d) { var n = typeof v === 'number' ? v : parseFloat(v); return isFinite(n) ? n : (d === undefined ? 0 : d); }
  function clean(n) { return Math.round(n * 1e6) / 1e6; }
  function str(v) { return v == null ? '' : String(v).replace(/\s+/g, ' ').trim(); }
  function familyOf(u) { for (var f in FAMILIES) if (FAMILIES[f][u] != null) return f; return null; }
  function convert(v, from, to) {
    var f = familyOf(from);
    if (!f || f !== familyOf(to)) return null;
    return v * FAMILIES[f][from] / FAMILIES[f][to];
  }
  function isWhole(n) { return Math.abs(n - Math.round(n)) < 1e-6; }
  function fmt(n) { return String(clean(num(n))); }
  function slug(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }

  function unitWord(u, n) {
    if (u === 'uL') return 'µL';
    if (u === 'ug') return 'µg';
    return (n !== 1 && PLURAL[u]) || u || '';
  }
  function amountText(n, u) { return fmt(n) + ' ' + unitWord(u, clean(num(n))); }

  /** 'aliquot' | 'material' | 'media' for a custom item, '' for anything bought. */
  function typeOf(item) {
    if (!item || !item.lab_made) return '';
    var t = item.lab_made_type;
    t = LEGACY_TYPES[t] || t;
    return TYPES[t] ? t : 'material';
  }
  function typeLabel(t) { t = LEGACY_TYPES[t] || t; return TYPES[t] || 'Custom item'; }

  /* "Fridge 2 / Box 001 " -> "Fridge 2/Box 001": one spelling per place. */
  function tidyLocation(s) { return str(s).replace(/\s*\/\s*/g, '/'); }

  /** Every location already used, tidied, deduped case-blind, sorted. */
  function locationNames(items) {
    var seen = {}, out = [];
    (items || []).forEach(function (it) {
      ((it && it.locations) || []).forEach(function (l) {
        var name = tidyLocation(l && l.name), k = name.toLowerCase();
        if (name && !seen[k]) { seen[k] = true; out.push(name); }
      });
    });
    return out.sort(function (a, b) { return a.localeCompare(b); }).slice(0, 500);
  }

  /** How the inventory counts this item, in words: "counted in mL · 450 left". */
  function stockText(item) {
    item = item || {};
    if (item.qty_tracked) {
      var iu = item.qty_unit || 'ea', rem = clean(num(item.qty_remaining));
      return 'counted in ' + unitWord(iu, 2) + ' · ' + fmt(rem) + ' left';
    }
    var q = num(item.quantity, NaN);
    return isFinite(q) && q > 0 ? 'not counted (Qty ' + fmt(q) + ')' : 'not counted';
  }

  /**
   * The units a "made from" row offers for this item. The FIRST is the default,
   * and is always the choice that cannot over-subtract. → [{ value, label }]
   */
  function unitChoices(item) {
    item = item || {};
    var out = [];
    if (item.qty_tracked) {
      var iu = item.qty_unit || 'ea';
      var rem = clean(num(item.qty_remaining));
      var fam = familyOf(iu);
      if (fam) {
        out.push({ value: iu, label: unitWord(iu, 2) + ' (' + fmt(rem) + ' left)' });
        Object.keys(FAMILIES[fam]).forEach(function (u) { if (u !== iu && MEASURES.indexOf(u) >= 0) out.push({ value: u, label: unitWord(u, 2) }); });
        return out;
      }
      if (MULTI.indexOf(iu) >= 0) {
        var holder = iu === 'ea' ? 'pack' : iu;
        out.push({ value: 'piece', label: 'single pieces from an open ' + holder });
        out.push({ value: iu, label: (iu === 'ea' ? 'as counted: ' + fmt(rem) + ' ea left' : 'whole ' + unitWord(iu, 2) + ', as counted (' + fmt(rem) + ' left)') });
        return out;
      }
      out.push({ value: iu, label: 'whole ' + unitWord(iu, 2) + ', as counted (' + fmt(rem) + ' left)' });
      var ef = familyOf(item.each_unit);
      if (num(item.each_amount) > 0 && ef) {
        Object.keys(FAMILIES[ef]).forEach(function (u) {
          if (MEASURES.indexOf(u) >= 0) out.push({ value: u, label: unitWord(u, 2) + ' (' + amountText(item.each_amount, item.each_unit) + ' per ' + iu + ')' });
        });
      }
      return out;
    }
    out.push({ value: 'piece', label: 'pieces' });
    var q = num(item.quantity, NaN);
    if (isFinite(q) && q > 0) out.push({ value: 'package', label: 'whole packages, as the Qty column counts them (' + fmt(q) + ')' });
    MEASURES.forEach(function (u) { out.push({ value: u, label: unitWord(u, 2) }); });
    return out;
  }

  /**
   * What using `amount unit` of `item` to make something does to the inventory.
   *   { take: true,  via: 'qty',    takeQty, takeUnit, before, after, over, text }  — INV_QTY.consume, in the item's own unit
   *   { take: true,  via: 'legacy', takeQty, before, after, text }                  — the untracked Qty column, whole packages
   *   { take: false, via: 'note',   reason, text }                                  — a delta-0 ledger row; nothing moves
   *   { error }
   * Every result also carries qty + unit: what the person said.
   */
  function planIngredient(item, amount, unit) {
    item = item || {};
    var n = clean(num(amount, 0));
    if (!(n > 0)) return { error: 'How much did you use?' };
    if (!unit) return { error: 'Pick a unit.' };
    var said = amountText(n, unit);
    function noted(reason, why) { return { take: false, via: 'note', qty: n, unit: unit, reason: reason, text: 'Noted only: ' + why }; }
    function take(q, u, extra) {
      q = clean(q);
      var rem = clean(num(item.qty_remaining)), after = clean(rem - q);
      return { take: true, via: 'qty', qty: n, unit: unit, takeQty: q, takeUnit: u, before: rem, after: after, over: after < 0,
               text: 'Takes ' + amountText(q, u) + ' off' + (extra || '') + ' · ' + amountText(after, u) + ' left' +
                     (after < 0 ? '. That is more than the inventory thinks is there; it will read below zero until someone recounts.' : '') };
    }

    if (!item.qty_tracked) {
      if (unit === 'package') {
        var q = num(item.quantity, NaN);
        if (!isFinite(q) || q <= 0) return noted('untracked', 'its Qty column is empty, so there is nothing to take off.');
        if (!isWhole(n)) return { error: 'Whole packages only, or pick pieces.' };
        var afterL = Math.max(0, clean(q - n));
        return { take: true, via: 'legacy', qty: n, unit: unit, takeQty: n, takeUnit: 'package', before: q, after: afterL, over: n > q,
                 text: 'Takes ' + amountText(n, 'package') + ' off its Qty column · ' + fmt(q) + ' → ' + fmt(afterL) };
      }
      return noted('untracked', 'this item’s amount is not counted in the inventory, so nothing is taken off.');
    }

    var iu = item.qty_unit || 'ea';
    var fam = familyOf(iu);
    if (unit === iu) {
      if (!fam && !isWhole(n)) return { error: 'Whole ' + unitWord(iu, 2) + ' only' + (MULTI.indexOf(iu) >= 0 ? ', or pick single pieces.' : '.') };
      return take(n, iu);
    }
    if (fam) {
      if (familyOf(unit) === fam) return take(convert(n, unit, iu), iu);
      return noted('mismatch', 'it is counted in ' + unitWord(iu, 2) + ', and ' + said + ' cannot be turned into ' + unitWord(iu, 2) + '.');
    }
    if (unit === 'piece') {
      var holder = iu === 'ea' ? 'pack' : iu;
      return noted('pieces', 'it is counted in ' + unitWord(iu, 2) + ', and single pieces from an open ' + holder +
                   ' do not change that count. Take the ' + holder + ' off when its last piece is gone.');
    }
    var each = num(item.each_amount), eu = item.each_unit;
    if (each > 0 && familyOf(eu) && familyOf(unit) === familyOf(eu)) {
      var k = convert(n, unit, eu) / each;
      if (isWhole(k) && Math.round(k) >= 1) {
        return take(Math.round(k), iu, ' (' + said + ' is ' + Math.round(k) + ' ' + unitWord(iu, Math.round(k)) + ' of ' + amountText(each, eu) + ')');
      }
      return noted('part', said + ' is part of a ' + iu + ' of ' + amountText(each, eu) + '; the count changes when a ' + iu + ' is finished.');
    }
    return noted('mismatch', 'it is counted in ' + unitWord(iu, 2) + ', and ' + said + ' cannot be turned into ' + unitWord(iu, 2) + '.');
  }

  /** The line under "How many": what one entry means. */
  function groupLine(v) {
    v = v || {};
    var count = num(v.count, 0), unit = v.unit || 'ea';
    var where = tidyLocation(v.location);
    var at = where ? ' at ' + where : '';
    if (!(count > 0)) return 'No count: the item is listed, but nothing is counted off when it is used.';
    if (familyOf(unit)) return amountText(count, unit) + at + ', one QR code.';
    var n = Math.round(count);
    var each = num(v.each_amount, 0) > 0 && familyOf(v.each_unit) ? ' of ' + amountText(v.each_amount, v.each_unit) + ' each' : '';
    if (n === 1) return '1 ' + unitWord(unit, 1) + each + at + '.';
    return n + ' ' + unitWord(unit, n) + each + ', together' + at + '; the same QR code goes on every ' + unitWord(unit, 1) + '.';
  }

  /** Labels to queue: one per container of a counted batch (capped), else one; 0 when not printing. */
  function labelCount(v) {
    if (!v || !v.print) return 0;
    var count = num(v.count, 0);
    if (count > 0 && !familyOf(v.unit)) return Math.min(Math.round(count), MAX_LABELS);
    return 1;
  }

  /** → [{ field, message }] for the form, one per problem. rows: [{ plan }]. */
  function validate(v, rows) {
    v = v || {};
    var errs = [];
    if (!TYPES[v.type]) errs.push({ field: 'type', message: 'Pick what it is.' });
    if (!str(v.name)) errs.push({ field: 'name', message: 'Give it a name.' });
    if (!str(v.description)) errs.push({ field: 'description', message: 'Describe it, so the lab knows what it is.' });
    if (!/[^\/\s]/.test(tidyLocation(v.location))) errs.push({ field: 'location', message: 'Say where it lives, e.g. fridge/box/001.' });
    var c = String(v.count == null ? '' : v.count).trim();
    if (c && !(num(c, NaN) >= 0)) errs.push({ field: 'count', message: 'How many should be a number.' });
    if (str(v.each_amount) && !(num(c, 0) > 0)) errs.push({ field: 'count', message: 'Say how many there are of these.' });
    (rows || []).forEach(function (r, i) { if (r.plan && r.plan.error) errs.push({ field: 'from', row: i, message: r.plan.error }); });
    return errs;
  }

  /** The inventory doc for a new custom item (no composition yet). who: { uid, name } */
  function buildItem(v, who, today) {
    v = v || {}; who = who || {};
    var type = TYPES[v.type] ? v.type : 'aliquot';
    var unit = v.unit || 'ea';
    var measure = !!familyOf(unit);
    var count = num(v.count, 0);
    count = count > 0 ? (measure ? clean(count) : Math.round(count)) : 0;
    var each = (!measure && count > 0 && num(v.each_amount, 0) > 0 && familyOf(v.each_unit)) ? clean(num(v.each_amount)) : 0;
    var date = v.made_on || today;
    var name = str(v.name);
    var doc = {
      id: slug(type + '-' + date + '-' + name).slice(0, 90).replace(/-+$/, ''),
      name: name,
      description: String(v.description || '').trim(),
      category: 'lab_made',
      subcategory: 'custom_' + type,
      lab_made: true,
      lab_made_type: type,
      made_by_uid: who.uid || '',
      made_by_name: who.name || '',
      vendor: '',
      vendor_normalized: '',
      catalogue_number: '',
      quantity: count || null,
      unit_price: null,
      date_acquired: date,
      is_consumable: true,
      condition: 'active',
      stock_status: 'full',
      locations: [{ name: tidyLocation(v.location), quantity: count || null, notes: '' }],
      locIds: [],
      price_history: [],
      tags: [],
      reorder: null,
      receipt_ref: null,
      safety: null,
      notes: '',
      manual_edit: true,
      parsed_at: '',
      parse_confidence: 0,
      composition: [],
    };
    if (count) { doc.qty_tracked = true; doc.qty_unit = unit; doc.qty_made = count; doc.qty_remaining = count; }
    if (each) { doc.each_amount = each; doc.each_unit = v.each_unit; }
    return doc;
  }

  /** One line of the recipe, stored on the new item. */
  function compositionEntry(item, plan) {
    item = item || {}; plan = plan || {};
    return {
      itemId: item.id || '', name: item.name || '', kind: item.kind || 'item',
      qty: plan.qty || 0, unit: plan.unit || '',
      taken: !!plan.take, taken_qty: plan.take ? plan.takeQty : 0, taken_unit: plan.take ? plan.takeUnit : '',
      note: plan.take ? '' : (plan.reason || ''),
    };
  }

  /** Inventory search for "made from": every word must match; name-prefix first; retired and lost left out. */
  function search(pool, q, limit, skipIds) {
    var words = str(q).toLowerCase().split(' ').filter(Boolean);
    if (!words.length) return [];
    var skip = {};
    (skipIds || []).forEach(function (id) { skip[id] = true; });
    var hits = [];
    (pool || []).forEach(function (it) {
      if (!it || !it.id || skip[it.id] || it.condition === 'retired' || it.condition === 'lost') return;
      var hay = [it.name, it.vendor, it.catalogue_number, it.description, it.made_by_name]
        .concat((it.locations || []).map(function (l) { return l && l.name; })).join(' ').toLowerCase();
      for (var i = 0; i < words.length; i++) if (hay.indexOf(words[i]) < 0) return;
      hits.push(it);
    });
    var first = words.join(' ');
    hits.sort(function (a, b) {
      var pa = String(a.name || '').toLowerCase().indexOf(first) === 0 ? 0 : 1;
      var pb = String(b.name || '').toLowerCase().indexOf(first) === 0 ? 0 : 1;
      return pa - pb || String(a.name || '').localeCompare(String(b.name || ''));
    });
    return hits.slice(0, limit || SEARCH_LIMIT);
  }

  var CORE = {
    TYPES: TYPES, TYPE_ORDER: TYPE_ORDER, START_UNIT: START_UNIT, CONTAINERS: CONTAINERS, MEASURES: MEASURES, MAX_LABELS: MAX_LABELS,
    typeOf: typeOf, typeLabel: typeLabel, unitWord: unitWord, amountText: amountText, tidyLocation: tidyLocation,
    locationNames: locationNames, stockText: stockText, unitChoices: unitChoices, planIngredient: planIngredient,
    groupLine: groupLine, labelCount: labelCount, validate: validate, buildItem: buildItem,
    compositionEntry: compositionEntry, search: search, familyOf: familyOf,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = CORE;
  if (!root || typeof root.document === 'undefined') return;
  root.INV_MADE_CORE = CORE;

  /* ── page half: the form ──────────────────────────────────────────────── */

  var CSS =
    '.imd-modal{display:flex;flex-direction:column;overflow:hidden;padding:0;}' +
    '.imd-modal .modal-title{padding:20px 24px 0;margin-bottom:12px;}' +
    '.imd-body{overflow-y:auto;padding:0 24px 8px;flex:1 1 auto;min-height:0;}' +
    '.imd-foot{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:12px 24px;border-top:1px solid var(--border);}' +
    '.imd-foot .imd-ferr{flex:1;color:var(--red);font-size:13px;}' +
    '.imd-note{font-size:12px;color:var(--text-muted);margin-top:4px;}' +
    '.imd-err{font-size:12px;color:var(--red);margin-top:4px;}' +
    '.imd-err:empty{display:none;}' +
    '.form-group .imd-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;}' +
    '.form-group .imd-row input.imd-num{width:96px;flex:0 0 auto;}' +
    '.form-group .imd-row select{width:auto;flex:0 1 auto;max-width:100%;}' +
    '.imd-each{display:inline-flex;gap:8px;align-items:center;flex-wrap:wrap;}' +
    '.imd-each-lbl{font-size:13px;color:var(--text-muted);}' +
    '.imd-sub{font-weight:400;}' +
    '.imd-ing{border:1px solid var(--border);border-radius:var(--radius);padding:8px 10px;margin-bottom:8px;background:var(--bg);}' +
    '.imd-ing-head{display:flex;justify-content:space-between;gap:8px;align-items:flex-start;margin-bottom:6px;}' +
    '.imd-ing-name{font-weight:600;font-size:14px;}' +
    '.imd-ing-meta{font-size:12px;color:var(--text-muted);}' +
    '.imd-x{border:none;background:none;color:var(--text-muted);cursor:pointer;padding:2px;line-height:0;}' +
    '.imd-x svg{width:18px;height:18px;}' +
    '.imd-plan{font-size:12px;margin-top:6px;}' +
    '.imd-plan.is-take{color:var(--green);}' +
    '.imd-plan.is-note{color:var(--text-muted);}' +
    '.imd-plan.is-over{color:var(--amber);}' +
    '.imd-plan.is-err{color:var(--red);}' +
    '.imd-results{display:flex;flex-direction:column;gap:4px;margin-top:6px;}' +
    '.imd-res{display:block;width:100%;text-align:left;border:1px solid var(--border);border-radius:var(--radius);' +
      'background:var(--surface);padding:6px 10px;cursor:pointer;font-size:14px;color:var(--text);}' +
    '.imd-res:hover,.imd-res:focus{border-color:var(--primary);outline:none;}' +
    '.imd-res small{display:block;font-size:12px;color:var(--text-muted);}' +
    '.form-group.imd-check label{display:flex;align-items:center;gap:8px;color:var(--text);}' +
    '.form-group.imd-check input{width:auto;}';
  function injectCss() {
    if (document.getElementById('imd-css')) return;
    var s = document.createElement('style');
    s.id = 'imd-css';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function icon(name) { return (root.ICON && ICON.svg) ? ICON.svg(name) : ''; }
  function db() { return firebridge.db(); }
  function ts() { return firebase.firestore.FieldValue.serverTimestamp(); }
  function me() {
    var u = (typeof firebridge !== 'undefined' && firebridge.getUser) ? firebridge.getUser() : null;
    var p = (typeof firebridge !== 'undefined' && firebridge.getProfile) ? (firebridge.getProfile() || {}) : {};
    u = u || {};
    return { uid: u.uid || '', name: p.name || p.displayName || u.displayName || String(u.email || '').split('@')[0], initials: p.initials || '' };
  }
  function localToday() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function inApp() {
    if (typeof _ourlabAppForm === 'function') { try { return _ourlabAppForm(); } catch (e) { return false; } }
    return !!(document.body && document.body.classList.contains('ourlab-app'));
  }
  function toast(msg, kind, opts) {
    if (!root.TOAST) return;
    (kind === 'error' ? TOAST.error : TOAST.success)(msg, opts);
  }

  function countUnitOptions(sel) {
    var html = '<optgroup label="Containers">' + CONTAINERS.map(function (u) {
      return '<option value="' + u + '"' + (u === sel ? ' selected' : '') + '>' + (u === 'ea' ? 'pieces' : unitWord(u, 2)) + '</option>';
    }).join('') + '</optgroup><optgroup label="Amount">' + MEASURES.map(function (u) {
      return '<option value="' + u + '"' + (u === sel ? ' selected' : '') + '>' + unitWord(u, 2) + '</option>';
    }).join('') + '</optgroup>';
    return html;
  }

  /**
   * opts: { items: () => [inventory items], create: async (doc) => item (writes it),
   *         opened: (item) => void (show it), chemicals: async () => [chemicals] (optional) }
   */
  function open(opts) {
    opts = opts || {};
    injectCss();
    var items = (opts.items && opts.items()) || [];
    if (inApp() && root.APP_SHEET) {
      APP_SHEET.open({ title: 'New custom item', build: function (body, api) {
        var foot = document.createElement('div');
        foot.className = 'imd-foot';
        foot.style.padding = '12px 0 0';
        var fields = document.createElement('div');
        body.appendChild(fields);
        body.appendChild(foot);
        buildForm(fields, foot, function () { api.close(); }, items, opts);
      } });
      return;
    }
    var overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    var modal = document.createElement('div');
    modal.className = 'modal imd-modal';
    modal.innerHTML = '<div class="modal-title">New custom item</div><div class="imd-body"></div><div class="imd-foot"></div>';
    overlay.appendChild(modal);
    var onKey = null;
    var doClose = function () { overlay.remove(); if (onKey) document.removeEventListener('keydown', onKey); };
    if (typeof safeCloseOnBackdrop === 'function') {
      var guard = safeCloseOnBackdrop(overlay, modal, doClose);
      onKey = function (e) { if (e.key === 'Escape') guard.confirmClose(doClose); };
      document.addEventListener('keydown', onKey);
    }
    document.body.appendChild(overlay);
    buildForm(modal.querySelector('.imd-body'), modal.querySelector('.imd-foot'), doClose, items, opts);
  }

  function buildForm(host, foot, close, items, opts) {
    var rows = [];             // [{ item, amount, unit, plan }]
    var unitTouched = false;
    var chems = null;          // loaded on the first search

    host.innerHTML =
      '<div class="form-group" data-f="type"><label for="imd-type">What is it? *</label>' +
        '<select id="imd-type" name="type"><option value="">— select —</option>' +
        TYPE_ORDER.map(function (t) { return '<option value="' + t + '">' + TYPES[t] + '</option>'; }).join('') +
        '</select><div class="imd-err"></div></div>' +
      '<div class="form-group" data-f="name"><label for="imd-name">Name *</label>' +
        '<input id="imd-name" name="name" type="text" placeholder="e.g. LLS 100 µm, rhodamine, spheres">' +
        '<div class="imd-note">Name it the way someone would look for it: size, shape, colour, concentration.</div><div class="imd-err"></div></div>' +
      '<div class="form-group" data-f="description"><label for="imd-desc">Description *</label>' +
        '<textarea id="imd-desc" name="description" rows="3" placeholder="What it is, how it was made, and anything someone needs to know before using it."></textarea><div class="imd-err"></div></div>' +
      '<div class="form-group" data-f="location"><label for="imd-loc">Where it lives *</label>' +
        '<input id="imd-loc" name="location" type="text" list="imd-locs" placeholder="e.g. fridge/box/001" autocomplete="off">' +
        '<datalist id="imd-locs">' + locationNames(items).map(function (n) { return '<option value="' + esc(n) + '">'; }).join('') + '</datalist>' +
        '<div class="imd-note">From the outside in, separated by slashes: fridge/box/001.</div><div class="imd-err"></div></div>' +
      '<div class="form-group" data-f="count"><label for="imd-count">How many</label>' +
        '<div class="imd-row">' +
          '<input id="imd-count" name="count" class="imd-num" type="number" min="0" step="any" inputmode="decimal" placeholder="e.g. 4" aria-label="How many">' +
          '<select name="unit" aria-label="Unit">' + countUnitOptions('tube') + '</select>' +
          '<span class="imd-each"><span class="imd-each-lbl">each holds</span>' +
            '<input name="each_amount" class="imd-num" type="number" min="0" step="any" inputmode="decimal" placeholder="e.g. 15" aria-label="Each holds">' +
            '<select name="each_unit" aria-label="Each holds, unit">' + MEASURES.map(function (u) { return '<option value="' + u + '"' + (u === 'mL' ? ' selected' : '') + '>' + unitWord(u, 2) + '</option>'; }).join('') + '</select>' +
          '</span>' +
        '</div><div class="imd-note imd-group"></div><div class="imd-err"></div></div>' +
      '<div class="form-group" data-f="from"><label for="imd-find">Made from <span class="imd-sub">what you used up (optional)</span></label>' +
        '<div class="imd-ings"></div>' +
        '<input id="imd-find" name="find" type="search" placeholder="Search the inventory for what you used…" autocomplete="off">' +
        '<div class="imd-results"></div><div class="imd-err"></div></div>' +
      '<div class="form-group" data-f="made_on"><label for="imd-date">Made on</label><input id="imd-date" name="made_on" type="date" value="' + localToday() + '"></div>' +
      '<div class="form-group imd-check" data-f="print"><label><input type="checkbox" name="print" checked> <span>Send its labels to the lab’s label printer <span class="imd-print-n"></span></span></label></div>';

    foot.innerHTML = '<div class="imd-ferr"></div><button type="button" class="btn imd-cancel">Cancel</button><button type="button" class="btn btn-primary imd-save">Save</button>';

    function $(sel) { return host.querySelector(sel); }
    function field(name) { return host.querySelector('[name="' + name + '"]'); }
    function values() {
      return {
        type: field('type').value, name: field('name').value, description: field('description').value,
        location: field('location').value, count: field('count').value, unit: field('unit').value,
        each_amount: field('each_amount').value, each_unit: field('each_unit').value,
        made_on: field('made_on').value, print: field('print').checked,
      };
    }

    function refreshAmount() {
      var v = values();
      var measure = !!familyOf(v.unit);
      $('.imd-each').style.display = measure ? 'none' : '';
      $('.imd-group').textContent = groupLine(v);
      var n = labelCount(Object.assign({}, v, { print: true }));
      $('.imd-print-n').textContent = n > 1 ? '(one per ' + unitWord(v.unit, 1) + ': ' + n + ' labels)' : '(1 label)';
    }

    /* ── made from ── */
    function pool() { return items.concat(chems || []); }
    function loadChems() {
      if (chems || !opts.chemicals) return;
      chems = [];
      Promise.resolve(opts.chemicals()).then(function (list) {
        chems = (list || []).map(function (c) { return Object.assign({ kind: 'chemical' }, c); });
      }).catch(function () { chems = []; });
    }
    function planRow(r) { r.plan = planIngredient(r.item, r.amount, r.unit); return r.plan; }
    function paintPlan(i) {
      var r = rows[i];
      var el = host.querySelector('.imd-ing[data-i="' + i + '"] .imd-plan');
      if (!r || !el) return;
      var p = planRow(r);
      el.className = 'imd-plan' + (p.error ? '' : (p.take ? (p.over ? ' is-over' : ' is-take') : ' is-note'));
      el.textContent = p.error ? (String(r.amount).trim() ? p.error : 'Say how much you used.') : p.text;
    }
    function paintRows() {
      $('.imd-ings').innerHTML = rows.map(function (r, i) {
        var meta = [r.item.kind === 'chemical' ? 'chemical' : (r.item.lab_made ? typeLabel(typeOf(r.item)).toLowerCase() : ''),
                    r.item.vendor, r.item.catalogue_number, stockText(r.item)].filter(Boolean).join(' · ');
        return '<div class="imd-ing" data-i="' + i + '">' +
          '<div class="imd-ing-head"><div><div class="imd-ing-name">' + esc(r.item.name || r.item.id) + '</div>' +
            '<div class="imd-ing-meta">' + esc(meta) + '</div></div>' +
            '<button type="button" class="imd-x" data-rm="' + i + '" aria-label="Remove ' + esc(r.item.name || '') + '" title="Remove">' + (icon('x-mark') || '×') + '</button></div>' +
          '<div class="imd-row"><input class="imd-num" type="number" min="0" step="any" inputmode="decimal" placeholder="amount" data-amt="' + i + '" value="' + esc(r.amount) + '" aria-label="Amount used">' +
            '<select data-unit="' + i + '" aria-label="Unit used">' + unitChoices(r.item).map(function (c) {
              return '<option value="' + esc(c.value) + '"' + (c.value === r.unit ? ' selected' : '') + '>' + esc(c.label) + '</option>';
            }).join('') + '</select></div>' +
          '<div class="imd-plan"></div></div>';
      }).join('');
      rows.forEach(function (r, i) { paintPlan(i); });
    }
    function paintResults() {
      var q = field('find').value;
      var hits = String(q).trim().length >= 2 ? search(pool(), q, SEARCH_LIMIT, rows.map(function (r) { return r.item.id; })) : [];
      $('.imd-results').innerHTML = hits.map(function (it) {
        var meta = [it.kind === 'chemical' ? 'chemical' : (it.lab_made ? typeLabel(typeOf(it)).toLowerCase() : ''), it.vendor, it.catalogue_number,
                    ((it.locations || [])[0] || {}).name, stockText(it)].filter(Boolean).join(' · ');
        return '<button type="button" class="imd-res" data-pick="' + esc(it.id) + '">' + esc(it.name || it.id) + '<small>' + esc(meta) + '</small></button>';
      }).join('') + (String(q).trim().length >= 2 && !hits.length ? '<div class="imd-note">Nothing in the inventory matches.</div>' : '');
    }
    var findTimer = null;
    field('find').addEventListener('focus', loadChems);
    field('find').addEventListener('input', function () { clearTimeout(findTimer); findTimer = setTimeout(paintResults, 120); });
    host.addEventListener('click', function (e) {
      var pick = e.target.closest('[data-pick]');
      if (pick) {
        var id = pick.getAttribute('data-pick');
        var it = pool().find(function (x) { return x.id === id; });
        if (!it) return;
        rows.push({ item: it, amount: '', unit: unitChoices(it)[0].value, plan: null });
        field('find').value = '';
        paintResults();
        paintRows();
        var amt = host.querySelector('[data-amt="' + (rows.length - 1) + '"]');
        if (amt) amt.focus();
        return;
      }
      var rm = e.target.closest('[data-rm]');
      if (rm) { rows.splice(Number(rm.getAttribute('data-rm')), 1); paintRows(); }
    });
    host.addEventListener('input', function (e) {
      var a = e.target.getAttribute && e.target.getAttribute('data-amt');
      if (a != null) { rows[Number(a)].amount = e.target.value; paintPlan(Number(a)); return; }
      if (e.target.name === 'count' || e.target.name === 'each_amount' || e.target.name === 'location') refreshAmount();
    });
    host.addEventListener('change', function (e) {
      var u = e.target.getAttribute && e.target.getAttribute('data-unit');
      if (u != null) { rows[Number(u)].unit = e.target.value; paintPlan(Number(u)); return; }
      if (e.target.name === 'unit') { unitTouched = true; refreshAmount(); }
      if (e.target.name === 'each_unit') refreshAmount();
      if (e.target.name === 'type' && !unitTouched && START_UNIT[e.target.value]) { field('unit').value = START_UNIT[e.target.value]; refreshAmount(); }
    });
    refreshAmount();

    /* ── save ── */
    function showErrors(errs) {
      host.querySelectorAll('.imd-err').forEach(function (el) { el.textContent = ''; });
      errs.forEach(function (er) {
        var g = host.querySelector('[data-f="' + er.field + '"] .imd-err');
        if (g && !g.textContent) g.textContent = er.row != null ? (rows[er.row].item.name + ': ' + er.message) : er.message;
      });
      if (!errs.length) return;
      var first = errs[0];
      var target = first.row != null ? host.querySelector('[data-amt="' + first.row + '"]') : host.querySelector('[data-f="' + first.field + '"] input, [data-f="' + first.field + '"] select, [data-f="' + first.field + '"] textarea');
      if (target) { try { target.focus(); } catch (e) {} }
    }

    foot.querySelector('.imd-cancel').addEventListener('click', close);
    var saveBtn = foot.querySelector('.imd-save');
    saveBtn.addEventListener('click', async function () {
      var v = values();
      rows.forEach(planRow);
      var errs = validate(v, rows);
      showErrors(errs);
      foot.querySelector('.imd-ferr').textContent = '';
      if (errs.length) return;
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving…';
      var who = me();
      var doc = buildItem(v, who, localToday());
      doc.composition = rows.map(function (r) { return compositionEntry(r.item, r.plan); });
      var made;
      try {
        made = await opts.create(doc);
      } catch (err) {
        foot.querySelector('.imd-ferr').textContent = 'Not saved: ' + ((err && err.message) || err);
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save';
        return;
      }
      close();
      await finish(made, rows, labelCount(v), opts);
    });
  }

  /* ── after the item exists: take / note each ingredient, then the labels ── */

  async function noteOrLegacy(made, r) {
    var who = me();
    var d = db();
    var itemRef = d.collection('inventory').doc(r.item.id);
    var usageRef = d.collection('inventoryUsage').doc();
    var p = r.plan;
    var out = null;
    await d.runTransaction(async function (t) {
      var snap = await t.get(itemRef);
      if (!snap.exists) throw new Error('it is no longer in the inventory');
      var live = snap.data() || {};
      var before, after, delta, unit, legacy = false;
      if (p.via === 'legacy') {
        if (live.qty_tracked) throw new Error('it is counted now; take it from its own panel');
        before = clean(num(live.quantity));
        after = Math.max(0, clean(before - p.takeQty));
        delta = clean(after - before);
        unit = 'package';
        legacy = true;
        t.update(itemRef, { quantity: after, last_used_at: ts(), last_used_by: who.uid, updatedAt: ts() });
      } else {
        before = after = clean(live.qty_tracked ? num(live.qty_remaining) : num(live.quantity));
        delta = 0;
        unit = p.unit;
      }
      t.set(usageRef, {
        itemId: r.item.id, itemKind: live.kind || r.item.kind || 'item', itemName: live.name || r.item.name || '',
        event: 'use', qty: p.qty, delta: delta, unit: unit, before: before, after: after,
        useMode: null, legacy: legacy, locId: null, labelCode: null,
        purpose: 'lab-made:' + made.id, madeItemId: made.id,
        note: 'Used to make ' + made.name + (p.via === 'note' ? ' (noted, not taken off: ' + p.reason + ')' : ''),
        reason: null, context: 'lab-made', undoes: null,
        userUid: who.uid, userName: who.name, userInitials: who.initials, overrideBy: null, createdAt: ts(),
      });
      out = { after: after, legacy: legacy };
    });
    if (out.legacy) r.item.quantity = out.after;   // the page's copy, so the repaint shows it
    try { if (typeof api !== 'undefined' && api.invalidate && root.INV_QTY) await api.invalidate(INV_QTY.routeFor(r.item)); } catch (e) {}
    return out;
  }

  async function finish(made, rows, labels, opts) {
    var taken = [], noted = [], failed = [];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i], p = r.plan;
      try {
        if (p.via === 'qty') {
          await INV_QTY.consume({ itemId: r.item.id, qty: p.takeQty, unit: p.takeUnit, context: 'lab-made',
                                  purpose: 'lab-made:' + made.id, note: 'Used to make ' + made.name });
          taken.push(amountText(p.takeQty, p.takeUnit) + ' ' + r.item.name);
        } else {
          await noteOrLegacy(made, r);
          (p.take ? taken : noted).push(amountText(p.qty, p.via === 'legacy' ? 'package' : p.unit) + ' ' + r.item.name);
        }
      } catch (err) {
        failed.push(r.item.name + ' (' + ((err && err.message) || err) + ')');
      }
    }
    var labelMsg = '';
    try {
      if (!root.INV_LABELS) throw new Error('the label tools did not load');
      if (labels > 0) {
        var copies = [];
        for (var k = 0; k < labels; k++) copies.push(made);
        await INV_LABELS.queue(copies, { note: typeLabel(made.lab_made_type) + ' — ' + made.name });
        labelMsg = ' QR code ' + made.label_code + '; ' + labels + (labels === 1 ? ' label' : ' labels') + ' queued at the label printer.';
      } else {
        await INV_LABELS.ensureCode(made);
        labelMsg = ' QR code ' + made.label_code + '.';
      }
    } catch (err) {
      failed.push('its QR label (' + ((err && err.message) || err) + '; press Print label in its panel)');
    }
    var msg = made.name + ' is in the inventory.' + labelMsg +
      (taken.length ? ' Taken off: ' + taken.join(', ') + '.' : '') +
      (noted.length ? ' Noted, not taken off: ' + noted.join(', ') + '.' : '');
    toast(msg, 'success', { ttl: 9000 });
    if (failed.length) toast('Saved ' + made.name + ', but these did not go through: ' + failed.join('; ') + '.', 'error');
    if (opts.opened) { try { opts.opened(made); } catch (e) { console.warn('[inventory-made] reopen failed:', e); } }
    return { taken: taken, noted: noted, failed: failed };
  }

  root.INV_MADE = { open: open, core: CORE };
})(typeof window !== 'undefined' ? window : null);
