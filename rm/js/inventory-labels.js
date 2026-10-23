/* inventory-labels.js — V3.834: a QR label for every inventory item, sent to
 * the lab's label printer or printed as a sheet.
 *
 * Alex: "for each item in the inventory, i want to add a qr code. this qr code
 * should be able to be linked to the label printer so the physical item can get
 * the qr link."
 *
 * HOW A CODE GETS ONTO AN ITEM
 *   An item has no code until someone asks for its label. ensureCode(item)
 *   mints one through SCAN_RESOLVE.mintAndBind (labels/{CODE} → this item,
 *   race-free, the V3.646 registry) and writes `label_code` on the item so the
 *   list can show it without a second read. A code is never minted twice for
 *   the same item, and never deleted — a reprint reuses it.
 *
 * WHAT THE QR SAYS
 *   MCGHEELAB.COM/L/MG-A7K2X — uppercase, so the symbol stays in QR
 *   alphanumeric mode (31 chars → version 2, the largest the printer's 111-dot
 *   strip can take). A phone camera opens https://mcgheelab.com/l/MG-A7K2X
 *   (l/.htaccess rewrites it to inventory.html?code=…); the app's scanner and
 *   a USB gun read the same string, and label-id.js normalize() keeps only the
 *   last path segment, so every reader ends at the same code.
 *
 * TWO WAYS TO PRINT
 *   1. queue(items) — a labelQueue job in the exact cell shape the printer's own
 *      LabelPrinter/web/core/batch.js emptyCell() uses (content, never
 *      geometry; the printer's layout.js keeps every fitting rule). The
 *      printer PC's Queue tab pulls it and prints.
 *   2. sheetUrl(items) — inventory-labels.html, a browser print page with
 *      label-stock presets, for any other printer or a sheet of stickers.
 *
 * The core (INV_LABELS_CORE) is DOM-free and node-tested. */
(function (root) {
  'use strict';

  var SITE_HOST = 'MCGHEELAB.COM';
  var MAX_CELLS = 200;   // firestore.rules labelQueue: cells.size() <= 200

  function str(v) { return v == null ? '' : String(v).replace(/\s+/g, ' ').trim(); }
  function today() { return new Date().toISOString().slice(0, 10); }
  function codeOf(item) { return str(item && item.label_code).toUpperCase(); }
  function payloadFor(code) { return SITE_HOST + '/L/' + str(code).toUpperCase(); }
  function linkFor(code) { return 'https://mcgheelab.com/l/' + str(code).toUpperCase(); }

  /** The printer's storage options (batch.js STORAGE_OPTIONS) from whatever the item says. */
  function storageFor(item) {
    var t = str(item && (item.storage_temp || item.storage || item.temp || item.storage_conditions)).toUpperCase();
    // V3.873 — no storage field (every lab-made item): read where it lives, so a
    // "fridge/box/001" tube is not printed RT.
    if (!t && item && Array.isArray(item.locations)) t = item.locations.map(function (l) { return str(l && l.name); }).join(' ').toUpperCase();
    if (/-80/.test(t)) return '-80C';
    if (/-20/.test(t)) return '-20C';
    if (/LN2|LIQUID N/.test(t)) return 'LN2';
    if (/\b4\s*°?\s*C\b|FRIDGE|REFRIG/.test(t)) return '4C';
    return 'RT';
  }

  /** One label cell in LabelPrinter emptyCell() shape — content only. */
  function cellFor(item, code, opts) {
    opts = opts || {};
    item = item || {};
    var locs = Array.isArray(item.locations) ? item.locations.map(function (l) { return str(l && (l.name || l.locId)); }).filter(Boolean) : [];
    var c = String(code || '').toUpperCase();
    return {
      reagent: str(item.name).slice(0, 80) || 'Item',
      // V3.875 — a custom item has no vendor; its second line is what each container holds.
      conc: (item.lab_made
        ? (item.each_amount ? str(item.each_amount) + ' ' + (item.each_unit === 'uL' ? 'µL' : str(item.each_unit)) : '')
        : [str(item.vendor), str(item.catalogue_number)].filter(Boolean).join(' · ')).slice(0, 48),
      solvent: '',
      owner: str(opts.initials).toUpperCase().slice(0, 4),
      date: opts.date || today(),
      expiry: '',
      expiryRule: '',
      lot: '',
      storage: storageFor(item),
      notes: locs.join(', ').slice(0, 60),
      hazards: [],
      fontScale: 'auto',
      // payload: the URL, in alphanumeric mode; force: keep the QR even when the
      // text column gets narrow — a label without its QR cannot be scanned.
      qr: { enabled: true, ecc: 'M', payload: payloadFor(c), force: true },
      tubeId: c,
      meta: { kind: 'item', itemId: str(item.id), source: 'inventory' },
    };
  }

  function chunk(list, n) { var out = []; for (var i = 0; i < list.length; i += n) out.push(list.slice(i, i + n)); return out; }

  /** labelQueue job documents (≤ MAX_CELLS cells each) for these items; codeFor(item) must already be known. */
  function jobsFor(items, codeFor, opts) {
    opts = opts || {};
    var cells = [], ids = [];
    (items || []).forEach(function (it) {
      var code = codeFor(it); if (!code) return;
      cells.push(cellFor(it, code, opts)); ids.push(it.id);
    });
    return chunk(cells, MAX_CELLS).map(function (part, i) {
      return { source: 'inventory', status: 'queued', cells: part,
               itemIds: ids.slice(i * MAX_CELLS, (i + 1) * MAX_CELLS),
               note: opts.note || ('Inventory labels (' + part.length + ')'), part: i + 1, parts: Math.ceil(cells.length / MAX_CELLS) };
    });
  }

  var CORE = { payloadFor, linkFor, codeOf, cellFor, jobsFor, storageFor, chunk, MAX_CELLS, SITE_HOST };
  if (typeof module !== 'undefined' && module.exports) module.exports = CORE;
  if (!root || typeof root.document === 'undefined') return;
  root.INV_LABELS_CORE = CORE;

  /* ── page half ─────────────────────────────────────────────────────── */
  function db() { return (typeof firebridge !== 'undefined' && firebridge.db) ? firebridge.db() : firebase.firestore(); }
  function me() { return (typeof firebridge !== 'undefined' && firebridge.getUser) ? firebridge.getUser() : (firebase.auth && firebase.auth().currentUser); }
  function ts() { return firebase.firestore.FieldValue.serverTimestamp(); }

  var _qrLoad = null;
  function loadQr() {
    if (root.QRCODE) return Promise.resolve(root.QRCODE);
    if (_qrLoad) return _qrLoad;
    _qrLoad = new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = '/rm/vendor/qrcode/qrcode.js';
      s.onload = function () { root.QRCODE ? res(root.QRCODE) : rej(new Error('QR encoder loaded but absent')); };
      s.onerror = function () { _qrLoad = null; rej(new Error('offline — the QR encoder is not cached yet')); };
      document.head.appendChild(s);
    });
    return _qrLoad;
  }

  /** SVG markup for a payload, `px` wide. */
  function qrSvg(payload, px) {
    return loadQr().then(function (Q) {
      var enc = Q.encode(String(payload).toUpperCase(), { ecc: 'M' });
      return Q.toSvg(enc.modules, { scale: 4, margin: 2, width: px || 120 });
    });
  }

  /** The item's code — minted and bound on first ask, written to the item as label_code. */
  async function ensureCode(item) {
    var have = codeOf(item);
    if (have) return have;
    if (!root.SCAN_RESOLVE) throw new Error('scan-resolve.js is not loaded');
    var code = await SCAN_RESOLVE.mintAndBind({
      kind: 'item', refId: item.id, title: item.name || '',
      snapshot: { vendor: item.vendor || '', catalogue_number: item.catalogue_number || '', category: item.category || '' },
      printedFrom: 'rm',
    });
    await db().collection('inventory').doc(item.id).update({ label_code: code, label_code_at: ts(), updatedAt: ts() });
    item.label_code = code;
    try { if (typeof api !== 'undefined' && api.invalidate && root.INV_QTY) await api.invalidate(INV_QTY.routeFor(item)); } catch (e) {}
    return code;
  }

  /** Queue labels for these items at the lab's printer. Resolves { jobs: [ids], cells }. */
  async function queue(items, opts) {
    opts = opts || {};
    var user = me(); if (!user) throw new Error('Sign in first.');
    var list = (items || []).filter(Boolean);
    if (!list.length) throw new Error('Nothing to print.');
    for (var i = 0; i < list.length; i++) await ensureCode(list[i]);   // sequential: each mint is a transaction
    var initials = opts.initials || '';
    try { var p = typeof firebridge !== 'undefined' && firebridge.getProfile ? firebridge.getProfile() : null; initials = initials || (p && p.initials) || ''; } catch (e) {}
    var jobs = jobsFor(list, codeOf, { initials: initials, note: opts.note });
    var ids = [];
    for (var j = 0; j < jobs.length; j++) {
      var ref = await db().collection('labelQueue').add(Object.assign(jobs[j], {
        requestedBy: user.uid, requestedByName: user.displayName || user.email || '', createdAt: ts(), updatedAt: ts(),
      }));
      ids.push(ref.id);
    }
    return { jobs: ids, cells: jobs.reduce(function (n, j) { return n + j.cells.length; }, 0) };
  }

  function sheetUrl(items) {
    var ids = (items || []).map(function (it) { return it && it.id; }).filter(Boolean);
    return '/rm/pages/inventory-labels.html?ids=' + encodeURIComponent(ids.join(','));
  }

  root.INV_LABELS = { ensureCode, qrSvg, loadQr, queue, sheetUrl, core: CORE };
})(typeof window !== 'undefined' ? window : null);
