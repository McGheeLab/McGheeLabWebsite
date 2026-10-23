/* inventory-labels.test.mjs — node scripts/tests/inventory-labels.test.mjs
 * V3.834: the vendored QR encoder is bit-identical to the label printer's own;
 * an item becomes a printer cell with the site URL as its QR payload; jobs
 * respect the rules cap; and a scan's plan (per use vs. package) is right for
 * tracked, untracked and finished items. */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const Q = require('../../rm/vendor/qrcode/qrcode.js');
const L = require('../../rm/js/inventory-labels.js');
const U = require('../../rm/js/inventory-use.js');
const esm = await import('/Users/alexmcghee/Documents/GitHub/LabelPrinter/web/core/qrcode.js').catch(() => null);

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  FAIL ' + m); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), m + ' → got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b));

console.log('── QR ──');
eq([L.payloadFor('mg-a7k2x'), L.linkFor('MG-A7K2X')], ['MCGHEELAB.COM/L/MG-A7K2X', 'https://mcgheelab.com/l/MG-A7K2X'], 'payload is the uppercase site path; the link is the https form');
const enc = Q.encode(L.payloadFor('MG-A7K2X'), { ecc: 'M' });
ok(enc.version === 2 && enc.mode === 'alphanumeric' && enc.size === 25, 'the URL payload stays alphanumeric at version 2 (fits the 111-dot strip): v' + enc.version + ' ' + enc.mode);
if (esm) { for (const t of ['MCGHEELAB.COM/L/MG-A7K2X', 'MG-9Y3RK', 'HELLO WORLD']) ok(JSON.stringify(Q.encode(t).modules) === JSON.stringify(esm.encode(t).modules), 'site and printer encoders agree on ' + t); }
else console.log('  (LabelPrinter repo not present — parity check skipped)');
const svg = Q.toSvg(enc.modules, { scale: 4, margin: 2, width: 96 });
ok(/^<svg /.test(svg) && /width="96"/.test(svg) && (svg.match(/h4v4h-4z/g) || []).length > 200, 'toSvg draws one path of modules at the asked width');

console.log('── label cells ──');
const item = { id: 'inv-1', name: '  Anti-β-tubulin antibody,  mouse monoclonal ', vendor: 'Sigma-Aldrich', catalogue_number: 'T4026', storage_temp: '-20 °C', locations: [{ name: 'Freezer B, box 4' }, { locId: 'shelf-a2' }] };
const cell = L.cellFor(item, 'mg-a7k2x', { initials: 'am', date: '2026-10-22' });
eq([cell.reagent, cell.conc, cell.owner, cell.date, cell.storage, cell.notes, cell.tubeId, cell.qr, cell.expiryRule, cell.hazards, cell.meta], ['Anti-β-tubulin antibody, mouse monoclonal', 'Sigma-Aldrich · T4026', 'AM', '2026-10-22', '-20C', 'Freezer B, box 4, shelf-a2', 'MG-A7K2X', { enabled: true, ecc: 'M', payload: 'MCGHEELAB.COM/L/MG-A7K2X', force: true }, '', [], { kind: 'item', itemId: 'inv-1', source: 'inventory' }], 'a cell in emptyCell() shape with the item’s facts');
eq([L.storageFor({ storage: '4C fridge' }), L.storageFor({ storage_temp: '−80' }), L.storageFor({ notes: 'LN2 dewar', storage: 'LN2' }), L.storageFor({})], ['4C', 'RT', 'LN2', 'RT'], 'storage mapping (a Unicode minus is not a hyphen → RT, deliberately conservative)');
const many = Array.from({ length: 205 }, (_, i) => ({ id: 'i' + i, name: 'Item ' + i, label_code: 'MG-' + String(i).padStart(5, '0') }));
const jobs = L.jobsFor(many, L.codeOf, { note: 'bulk' });
eq([jobs.length, jobs[0].cells.length, jobs[1].cells.length, jobs[0].part, jobs[0].parts, jobs[0].itemIds.length, jobs[1].itemIds[0], jobs[0].status, jobs[0].source], [2, 200, 5, 1, 2, 200, 'i200', 'queued', 'inventory'], 'jobs split at the rules cap of 200 cells, item ids aligned');
eq(L.jobsFor([{ id: 'x', name: 'no code' }], L.codeOf).length, 0, 'an item without a code is skipped (ensureCode runs first on the page)');

console.log('── use plans ──');
const P = U.plan;
eq([U.modeOf({ use_mode: 'per_use' }), U.modeOf({ is_consumable: true }), U.modeOf({}), U.modeOf({ use_mode: 'bogus', is_consumable: true })], ['per_use', 'package', '', 'package'], 'mode: designated, else consumable → package, else none');
const ab = { use_mode: 'per_use', qty_tracked: true, qty_remaining: 3, qty_unit: 'ea', qty_made: 5, qty_min: 1, use_count: 7 };
eq(P(ab, { kind: 'use' }), { via: 'log', mode: 'per_use', event: 'use', qty: 1, unit: 'use', delta: 0, before: 3, after: 3, itemPatch: { use_count: 8 }, low: false, last: false }, 'per use: a log row, nothing moves, use_count +1');
eq(P(ab, { kind: 'finish' }), { via: 'qty', mode: 'per_use', event: 'use', qty: 1, unit: 'ea', delta: -1, before: 3, after: 2, itemPatch: { use_count: 0 }, low: false, last: false }, 'finished one: one unit off through the ledger, uses reset');
const tips = { use_mode: 'package', qty_tracked: true, qty_remaining: 2, qty_unit: 'pack', qty_made: 10, qty_min: null };
eq(P(tips, { kind: 'take', n: 2 }), { via: 'qty', mode: 'package', event: 'use', qty: 2, unit: 'pack', delta: -2, before: 2, after: 0, itemPatch: {}, low: true, last: true }, 'package, tracked: two packs off → low (20 % of 10) and the last one');
const legacy = { is_consumable: true, quantity: '3' };
eq(P(legacy, { kind: 'take' }), { via: 'legacy', mode: 'package', event: 'use', qty: 1, unit: 'ea', delta: -1, before: 3, after: 2, itemPatch: { quantity: 2 }, low: false, last: false }, 'package, untracked: the legacy Qty scalar drops (string coerced), ledger row still written');
eq(P({ quantity: 0, use_mode: 'package' }, { kind: 'take', n: 3 }).after, 0, 'never below zero');
eq(P({ use_mode: 'per_use' }, { kind: 'use', n: 2 }).itemPatch, { use_count: 2 }, 'n uses at once');
eq([U.lowAt({ qty_tracked: true, qty_made: 50 }), U.lowAt({ qty_tracked: true, qty_made: 50, qty_min: 4 }), U.lowAt({})], [10, 4, 1], 'reorder point: explicit min, else 20 %, untracked 1');

console.log(`inventory-labels: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
