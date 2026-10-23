/* inventory-qty.js — V3.646. The one place quantity arithmetic happens.
 *
 * WHY THIS FILE EXISTS
 * ────────────────────
 * Before V3.646 inventory carried THREE unreconciled numbers with nothing
 * summing or validating them: a scalar `quantity` (edited through a text input,
 * so it sometimes held a string), a `locations[]` array that 0 of 777 items
 * populated, and a hand-set `stock_status` whose 'low'/'out_of_stock' values
 * appeared on ZERO rows — so the Low/Out tab, the amber dashboard card and the
 * protocol stock chips were live code paths that had never rendered anything.
 *
 * The new fields sit ALONGSIDE `quantity`, never replacing it:
 *
 *   qty_tracked   boolean   absent/false ⇒ nothing here applies. THE OPT-IN.
 *   qty_unit      string    'ea' | 'mL' | 'uL' | 'L' | 'g' | 'mg' | 'pack' | …
 *   qty_made      number    stock: the batch size. item: qty at last recount.
 *   qty_remaining number    THE authoritative "how much is left"
 *   qty_min       number?   reorder point; null ⇒ the 20%-of-made fallback
 *
 * `quantity` is read as a display scalar in 6+ places, written by 4 paths, has
 * no unit anywhere, and means something different for a batch (500 mL) than a
 * purchase (1 box). Repairing it in place would mean auditing all of them and
 * hoping.
 *
 * WHY A TRANSACTION AND NOT FieldValue.increment()
 * ───────────────────────────────────────────────
 * increment() is atomic and race-free, but the client never learns the server
 * value — so it cannot write `before`/`after` on the ledger row, and
 * before/after IS the audit guarantee (row N's `before` must equal row N-1's
 * `after`, which makes a lost write or a rogue edit DETECTABLE by scanning
 * history rather than trusting the counter). Inside a transaction we already
 * know `before`, so we write the explicit number. That also lets firestore.rules
 * evaluate qty_remaining as a plain number instead of reasoning about how a
 * sentinel transform resolves mid-rule.
 *
 * A manager override is therefore NOT a privileged silent write — it is a
 * ledger row like any other, with the delta computed server-relative inside the
 * transaction.
 *
 * Global: window.INV_QTY
 */
(function () {
  'use strict';

  var ITEMS_PATH = 'inventory/items.json';
  var CHEMS_PATH = 'inventory/chemicals.json';
  var STOCK_PATH = 'inventory/stock.json';

  /* Fraction of qty_made at or below which a batch with no explicit qty_min
   * counts as low. "You're down to the last fifth of that batch" is meaningful
   * for something you MADE; an absolute reorder point is meaningful for
   * something you BUY. Support both; explicit qty_min wins.
   *
   * MUST match LOW_PCT in functions/helpers/inventory-thresholds.js — the
   * function recomputes severity from the numbers rather than trusting the
   * client's stock_status, and two implementations that drift would argue. */
  var LOW_PCT = 0.20;

  var EVENTS = ['use', 'recount', 'add', 'discard', 'transfer'];

  /* Units, grouped into convertible families. A unit picker offered outside a
   * family is how you get "took 5 boxes of a liquid", so the UI only shows a
   * <select> when unitFamily() returns something. */
  var FAMILIES = {
    volume: { uL: 0.001, mL: 1, L: 1000 },
    mass:   { ug: 0.001, mg: 1, g: 1000, kg: 1000000 },
  };
  var COUNT_UNITS = ['ea', 'pack', 'box', 'vial', 'tube', 'plate', 'aliquot', 'slide', 'bottle'];
  var ALL_UNITS = ['ea', 'mL', 'uL', 'L', 'g', 'mg', 'ug', 'pack', 'box', 'vial',
                   'tube', 'plate', 'aliquot', 'slide', 'bottle'];

  function unitFamily(unit) {
    for (var f in FAMILIES) if (FAMILIES[f][unit] != null) return f;
    return null;
  }
  function convert(v, from, to) {
    var f = unitFamily(from);
    if (!f || f !== unitFamily(to)) return null;
    return v * FAMILIES[f][from] / FAMILIES[f][to];
  }
  function isCountUnit(u) { return COUNT_UNITS.indexOf(u) >= 0; }

  function isTracked(item) { return !!(item && item.qty_tracked); }

  function num(v, dflt) {
    var n = typeof v === 'number' ? v : parseFloat(v);
    return isFinite(n) ? n : (dflt === undefined ? 0 : dflt);
  }

  /* Round away float noise so a ledger of mL doesn't accumulate
   * 449.99999999999994. 6 decimals is far finer than any pipette. */
  function clean(n) { return Math.round(n * 1e6) / 1e6; }

  /* ── severity + the derived stock_status ────────────────────────────────
   *
   * severity() is the shared vocabulary; deriveStatus() maps it onto the
   * EXISTING stock_status enum so all four legacy consumers (inventory.js:34
   * Low/Out tab, dashboard.js:299 amber card, protocol-inventory.js:227 chips
   * and :142 match tiebreak) keep working with ZERO edits — they simply start
   * returning non-empty results for the first time.
   *
   * Returns null for an untracked item, meaning "leave stock_status alone". */
  function severity(item) {
    if (!isTracked(item)) return 'na';
    var rem = num(item.qty_remaining);
    if (rem <= 0) return 'out';
    var min = item.qty_min;
    if (min != null && isFinite(num(min, NaN))) return rem <= num(min) ? 'low' : 'full';
    var made = num(item.qty_made);
    if (made > 0 && rem / made <= LOW_PCT) return 'low';
    return 'full';
  }

  function deriveStatus(item) {
    if (!isTracked(item)) return null;
    var s = severity(item);
    return s === 'out' ? 'out_of_stock' : (s === 'low' ? 'low' : 'full');
  }

  function routeFor(item) {
    var k = (item && item.kind) || 'item';
    return k === 'chemical' ? CHEMS_PATH : (k === 'stock' ? STOCK_PATH : ITEMS_PATH);
  }

  /* ── local-write listeners ──────────────────────────────────────────────
   *
   * A page that renders inventory needs to (a) suppress its own live-sync echo
   * and (b) repaint. inventory.js registers a listener that bumps
   * _invLive.suppressUntil and re-renders; the consume sheet needs no knowledge
   * of either. */
  var listeners = [];
  function onLocalWrite(fn) {
    listeners.push(fn);
    return function () { listeners = listeners.filter(function (f) { return f !== fn; }); };
  }
  function fireLocalWrite(info) {
    listeners.forEach(function (fn) {
      try { fn(info); } catch (e) { console.warn('[inv-qty] listener threw:', e); }
    });
  }

  function db() {
    if (typeof firebridge === 'undefined' || !firebridge.db) throw new Error('Firestore unavailable');
    return firebridge.db();
  }
  function me() {
    var u = (typeof firebridge !== 'undefined' && firebridge.getUser) ? firebridge.getUser() : null;
    if (!u) throw new Error('Not signed in');
    return u;
  }
  function myName() {
    var p = (typeof firebridge !== 'undefined' && firebridge.getProfile) ? firebridge.getProfile() : null;
    return (p && (p.name || p.displayName)) || (me().email || '').split('@')[0] || '';
  }
  function myInitials() {
    var p = (typeof firebridge !== 'undefined' && firebridge.getProfile) ? firebridge.getProfile() : null;
    return (p && p.initials) || '';
  }
  function ts() { return firebase.firestore.FieldValue.serverTimestamp(); }

  /* ── the one write path ─────────────────────────────────────────────────
   *
   * `mode` is 'delta' (a consumption event — qty is subtracted) or 'absolute'
   * (a recount — qty IS the new remaining). Both produce one item update and
   * one immutable ledger row, atomically.
   *
   * Rules let a member only DECREASE, so an 'absolute' write that raises the
   * count fails with permission-denied for a non-manager. That is the intended
   * server-side backstop, not something to pre-empt with a client check. */
  async function write(opts) {
    var itemId = opts.itemId;
    if (!itemId) throw new Error('itemId required');
    var mode = opts.mode || 'delta';
    var event = opts.event || (mode === 'absolute' ? 'recount' : 'use');
    if (EVENTS.indexOf(event) < 0) throw new Error('unknown event: ' + event);

    var user = me();
    var d = db();
    var itemRef = d.collection('inventory').doc(itemId);
    var usageRef = d.collection('inventoryUsage').doc();
    var out = null;

    await d.runTransaction(async function (t) {
      var snap = await t.get(itemRef);
      if (!snap.exists) throw new Error('That item no longer exists.');
      var item = Object.assign({ id: itemId }, snap.data());

      if (!isTracked(item) && !opts.allowUntracked) {
        throw new Error('Quantity tracking is not switched on for this item.');
      }

      var before = clean(num(item.qty_remaining));
      var after, delta, qty;

      if (mode === 'absolute') {
        after = clean(num(opts.to));
        delta = clean(after - before);
        qty = Math.abs(after);
      } else {
        qty = clean(Math.abs(num(opts.qty)));
        if (!qty) throw new Error('Enter an amount.');
        // A unit in the same family is converted rather than refused — someone
        // who takes 500 uL of a mL-denominated stock is not making a mistake.
        var unit = opts.unit || item.qty_unit || '';
        if (unit && item.qty_unit && unit !== item.qty_unit) {
          var conv = convert(qty, unit, item.qty_unit);
          if (conv == null) {
            throw new Error('Cannot record ' + unit + ' against an item measured in ' + item.qty_unit + '.');
          }
          qty = clean(conv);
        }
        delta = event === 'add' ? qty : -qty;
        after = clean(before + delta);
      }

      var patch = {
        qty_remaining: after,
        qty_tracked: true,
        updatedAt: ts(),
      };
      // deriveStatus needs the POST-write numbers, so derive off a merged copy.
      var derived = deriveStatus(Object.assign({}, item, { qty_remaining: after, qty_tracked: true }));
      if (derived) patch.stock_status = derived;
      if (mode === 'absolute') {
        patch.qty_recounted_at = ts();
        if (opts.setMade) patch.qty_made = clean(num(opts.to));
      } else {
        patch.lastUsedAt = ts();
        patch.lastUsedBy = user.uid;
      }
      if (opts.itemPatch) Object.assign(patch, opts.itemPatch);

      t.update(itemRef, patch);
      t.set(usageRef, {
        itemId: itemId,
        itemKind: item.kind || 'item',
        itemName: item.name || '',
        event: event,
        qty: qty,
        delta: delta,
        unit: item.qty_unit || opts.unit || '',
        before: before,
        after: after,
        locId: opts.locId || null,
        labelCode: opts.labelCode || null,
        purpose: opts.purpose || null,
        note: opts.note || '',
        reason: opts.reason || null,
        context: opts.context || null,
        undoes: opts.undoes || null,
        userUid: user.uid,
        userName: myName(),
        userInitials: myInitials(),
        overrideBy: mode === 'absolute' ? user.uid : null,
        createdAt: ts(),
      });

      out = { itemId: itemId, usageId: usageRef.id, before: before, after: after,
              delta: delta, qty: qty, unit: item.qty_unit || '', status: derived,
              // V3.844 — user-actions.js records every 'use' from onLocalWrite
              event: event, note: opts.note || '', labelCode: opts.labelCode || null, context: opts.context || null,
              useMode: (opts.itemPatch && opts.itemPatch.use_mode) || item.use_mode || '',
              item: Object.assign({}, item, patch, { qty_remaining: after }) };
    });

    // The counter lives on a doc the inventory route already covers, so
    // invalidating that route + the page's existing api.subscribe listener
    // propagates the new number to every open tab with no new sync machinery.
    // The LEDGER is deliberately never routed (unbounded append — the one shape
    // the full-collection api.save model is actively wrong for).
    try {
      if (typeof api !== 'undefined' && api.invalidate) {
        await api.invalidate(routeFor(out.item));
      }
    } catch (e) { /* cache hygiene must never fail a completed write */ }

    fireLocalWrite(out);
    return out;
  }

  /* Record taking material. */
  function consume(opts) {
    return write(Object.assign({}, opts, { mode: 'delta', event: opts.event || 'use' }));
  }

  /* Manager override to an absolute value. `reason` is required by the UI, not
   * by rules — a recount with no reason is an unexplained number. */
  function recount(opts) {
    return write(Object.assign({}, opts, { mode: 'absolute', event: 'recount' }));
  }

  /* Undo writes a COMPENSATING row plus the inverse delta — never a delete.
   * A delete would race the counter and leave it silently wrong, and the ledger
   * is append-only by design. */
  async function undo(usageId) {
    var d = db();
    var snap = await d.collection('inventoryUsage').doc(usageId).get();
    if (!snap.exists) throw new Error('That entry is gone.');
    var row = snap.data();
    if (row.undoes) throw new Error('That was already an undo.');
    return write({
      itemId: row.itemId,
      mode: 'delta',
      // An undo of a 'use' ADDS stock back, which rules only permit for a
      // manager. So an ordinary member's undo is expressed as event:'use' with
      // a positive delta — which rules also refuse. Route it through 'add' and
      // let the server decide; the sheet only offers Undo where it will work.
      event: 'add',
      qty: Math.abs(num(row.delta)),
      unit: row.unit,
      note: 'Undo of ' + (row.event || 'entry'),
      undoes: usageId,
    });
  }

  /* Turn tracking on for a legacy item. Manager-only per rules (qty_tracked is
   * in qtyControlsUnchanged), and deliberately so — it is a curation decision.
   * Coerces the possibly-string legacy `quantity` through Number() and writes a
   * baseline ledger row so the before/after chain starts somewhere real. */
  async function enableTracking(opts) {
    var itemId = opts.itemId;
    var d = db();
    var itemRef = d.collection('inventory').doc(itemId);
    var usageRef = d.collection('inventoryUsage').doc();
    var user = me();
    var out = null;

    await d.runTransaction(async function (t) {
      var snap = await t.get(itemRef);
      if (!snap.exists) throw new Error('That item no longer exists.');
      var item = snap.data();
      var made = opts.made != null ? clean(num(opts.made)) : clean(num(item.quantity, 0));
      var unit = opts.unit || 'ea';
      var min = opts.min == null || opts.min === '' ? null : clean(num(opts.min));
      var patch = {
        qty_tracked: true, qty_unit: unit, qty_made: made, qty_remaining: made,
        qty_min: min, qty_recounted_at: ts(), updatedAt: ts(),
      };
      patch.stock_status = deriveStatus(Object.assign({}, item, patch)) || 'full';
      t.update(itemRef, patch);
      t.set(usageRef, {
        itemId: itemId, itemKind: item.kind || 'item', itemName: item.name || '',
        event: 'recount', qty: made, delta: 0, unit: unit,
        before: made, after: made, note: 'Tracking switched on — baseline count',
        userUid: user.uid, userName: myName(), userInitials: myInitials(),
        overrideBy: user.uid, createdAt: ts(),
      });
      out = { itemId: itemId, made: made, unit: unit, item: Object.assign({}, item, patch) };
    });

    try {
      if (typeof api !== 'undefined' && api.invalidate) await api.invalidate(routeFor(out.item));
    } catch (e) { /* non-fatal */ }
    fireLocalWrite(out);
    return out;
  }

  /* The per-item history panel. Deliberately a live read on expand: ~20 docs,
   * on demand, no route, no cache to go stale, always truthful. */
  async function recent(itemId, n) {
    var snap = await db().collection('inventoryUsage')
      .where('itemId', '==', itemId)
      .orderBy('createdAt', 'desc')
      .limit(n || 20)
      .get();
    return snap.docs.map(function (x) { return Object.assign({ id: x.id }, x.data()); });
  }

  /* ── preset amounts ─────────────────────────────────────────────────────
   *
   * The primary input on the take-from-stock sheet, because tapping a chip is
   * one thumb and no keyboard. Derived from the unit and what is left:
   *   count units → 1 2 3 5 10 (never more than remaining)
   *   a measure   → "nice" values scaled to remaining
   *   no unit     → NO CHIPS. Never guess. */
  function presets(item) {
    if (!item || !item.qty_unit) return [];
    var rem = num(item.qty_remaining);
    if (isCountUnit(item.qty_unit)) {
      return [1, 2, 3, 5, 10].filter(function (v) { return v <= Math.max(1, rem); });
    }
    if (!unitFamily(item.qty_unit) || rem <= 0) return [];
    // Pick a decade from remaining, then offer a 1/2/5/10 ladder inside it.
    var mag = Math.pow(10, Math.floor(Math.log(rem) / Math.LN10) - 1);
    var ladder = [1, 2.5, 5, 10].map(function (m) { return clean(m * mag); });
    return ladder.filter(function (v) { return v > 0 && v <= rem; }).slice(0, 4);
  }

  /* "412 mL remaining of 500 mL" — the line someone reads through fogged
   * goggles, so it is built in one place rather than per surface. */
  function summary(item) {
    if (!isTracked(item)) return '';
    var u = item.qty_unit ? ' ' + item.qty_unit : '';
    var rem = clean(num(item.qty_remaining));
    var made = num(item.qty_made);
    return made > 0
      ? rem + u + ' remaining of ' + clean(made) + u
      : rem + u + ' remaining';
  }

  function fractionLeft(item) {
    var made = num(item && item.qty_made);
    if (!made) return null;
    return Math.max(0, Math.min(1, num(item.qty_remaining) / made));
  }

  window.INV_QTY = {
    LOW_PCT: LOW_PCT,
    EVENTS: EVENTS,
    ALL_UNITS: ALL_UNITS,
    COUNT_UNITS: COUNT_UNITS,
    isTracked: isTracked,
    isCountUnit: isCountUnit,
    unitFamily: unitFamily,
    convert: convert,
    severity: severity,
    deriveStatus: deriveStatus,
    presets: presets,
    summary: summary,
    fractionLeft: fractionLeft,
    clean: clean,
    num: num,
    consume: consume,
    recount: recount,
    undo: undo,
    enableTracking: enableTracking,
    recent: recent,
    onLocalWrite: onLocalWrite,
  };
})();
