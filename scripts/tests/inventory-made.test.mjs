// V3.875 — INV_MADE_CORE: the custom-item builder and the "made from" planner.
// The planner's one job: subtract only what is exact in the unit the inventory
// counts the item in. "4 tubes" from a pack of tubes must never become 4 packs.
// Run: node scripts/tests/inventory-made.test.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const M = require('../../rm/js/inventory-made.js');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  FAIL ' + m); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), m + ' → got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b));
const pick = (o, keys) => Object.fromEntries(keys.map(k => [k, o[k]]));

// Fixtures, the shapes production holds.
const tubesPack = { id: 'conical-15', name: 'Conical tubes 15 mL, pack of 50', qty_tracked: true, qty_unit: 'pack', qty_remaining: 12, qty_made: 20 };
const tubesEa   = { id: 'conical-15-ea', name: 'Conical tubes 15 mL', qty_tracked: true, qty_unit: 'ea', qty_remaining: 6 };
const fbs       = { id: 'fbs', name: 'FBS', qty_tracked: true, qty_unit: 'mL', qty_remaining: 450 };
const matrigel  = { id: 'matrigel', name: 'Matrigel', qty_tracked: true, qty_unit: 'vial', qty_remaining: 3 };
const lls       = { id: 'lls', name: 'LLS 100 µm', lab_made: true, lab_made_type: 'material', qty_tracked: true, qty_unit: 'tube', qty_remaining: 4, each_amount: 15, each_unit: 'mL' };
const dmem      = { id: 'dmem', name: 'DMEM', quantity: 3 };
const pbs       = { id: 'pbs', name: 'PBS 10X' };

console.log('── kinds ──');
eq([M.typeOf({ lab_made: true, lab_made_type: 'aliquot' }), M.typeOf({ lab_made: true, lab_made_type: 'made_in_lab' }), M.typeOf({ lab_made: true, lab_made_type: 'media' }), M.typeOf({ subcategory: 'media' }), M.typeOf({ lab_made: true })],
   ['aliquot', 'material', 'media', '', 'material'], 'typeOf: the three kinds, V3.873 made_in_lab reads as material, a BOUGHT item with subcategory media is not custom');
eq([M.typeLabel('aliquot'), M.typeLabel('material'), M.typeLabel('media'), M.typeLabel('made_in_lab')], ['Custom aliquot', 'Custom material', 'Custom media', 'Custom material'], 'the words Alex asked for');

console.log('── the unit a row starts on can never over-subtract ──');
eq(M.unitChoices(tubesPack).map(c => c.value), ['piece', 'pack'], 'a pack: single pieces first, whole packs second');
eq(M.unitChoices(tubesEa).map(c => c.value), ['piece', 'ea'], "'ea' (often a pack): single pieces first");
eq(M.unitChoices(fbs).map(c => c.value), ['mL', 'uL', 'L'], 'a measure: its own unit, then its family');
eq(M.unitChoices(matrigel).map(c => c.value), ['vial'], 'a vial count: vials only');
eq(M.unitChoices(lls).map(c => c.value), ['tube', 'uL', 'mL', 'L'], 'a group of 15 mL tubes: tubes, then volumes');
eq(M.unitChoices(dmem).map(c => c.value), ['piece', 'package', 'uL', 'mL', 'L', 'mg', 'g'], 'untracked with a Qty: pieces first, whole packages offered');
eq(M.unitChoices(pbs).map(c => c.value).includes('package'), false, 'untracked, no Qty: no packages to take');
for (const it of [tubesPack, tubesEa, fbs, matrigel, lls, dmem, pbs]) {
  const p = M.planIngredient(it, 4, M.unitChoices(it)[0].value);
  const bad = p.take && ['pack', 'box', 'ea', 'package'].includes(p.takeUnit);
  ok(!bad, 'default unit on ' + it.id + ' never takes whole packs/ea/packages: ' + p.text);
}

console.log('── 4 tubes are not 4 packs ──');
let p = M.planIngredient(tubesPack, 4, 'piece');
eq(pick(p, ['take', 'via', 'qty', 'unit', 'reason']), { take: false, via: 'note', qty: 4, unit: 'piece', reason: 'pieces' }, '4 single tubes from a pack: NOTED, not taken');
ok(/counted in packs/.test(p.text) && /open pack/.test(p.text), 'and it says why: ' + p.text);
eq(M.planIngredient(tubesPack, 4, 'tube').take, false, '"tube" against a pack count (not offered, but if sent): noted');
eq(pick(M.planIngredient(tubesPack, 1, 'pack'), ['take', 'takeQty', 'takeUnit', 'after']), { take: true, takeQty: 1, takeUnit: 'pack', after: 11 }, 'a whole pack, chosen on purpose: taken');
ok(!!M.planIngredient(tubesPack, 1.5, 'pack').error, 'half a pack: refused (pick pieces)');
eq(M.planIngredient(tubesEa, 4, 'piece').take, false, "4 pieces of an 'ea' count: noted");
eq(pick(M.planIngredient(tubesEa, 2, 'ea'), ['take', 'takeQty', 'after']), { take: true, takeQty: 2, after: 4 }, "'ea' as counted, chosen on purpose: taken");

console.log('── measures convert, families never cross ──');
eq(pick(M.planIngredient(fbs, 50, 'mL'), ['take', 'via', 'takeQty', 'takeUnit', 'before', 'after', 'over']), { take: true, via: 'qty', takeQty: 50, takeUnit: 'mL', before: 450, after: 400, over: false }, '50 mL of FBS: taken');
eq(pick(M.planIngredient(fbs, 500, 'uL'), ['takeQty', 'takeUnit', 'after']), { takeQty: 0.5, takeUnit: 'mL', after: 449.5 }, '500 µL against mL: converted');
eq(pick(M.planIngredient(fbs, 0.1, 'L'), ['takeQty', 'after']), { takeQty: 100, after: 350 }, '0.1 L: 100 mL');
eq(M.planIngredient(fbs, 2, 'piece').take, false, 'pieces of a measured item: noted');
p = M.planIngredient(fbs, 500, 'mL');
eq([p.take, p.after, p.over], [true, -50, true], 'more than is left: taken, below zero, flagged');
ok(/below zero/.test(p.text), 'and said: ' + p.text);
eq(pick(M.planIngredient(matrigel, 1, 'vial'), ['take', 'takeQty', 'after']), { take: true, takeQty: 1, after: 2 }, 'a vial of Matrigel: taken');
eq(pick(M.planIngredient(matrigel, 2, 'mL'), ['take', 'reason']), { take: false, reason: 'mismatch' }, 'mL against a vial count with no size: noted');
ok(!!M.planIngredient(matrigel, 0.5, 'vial').error, 'half a vial as counted: refused');

console.log('── a group of 15 mL tubes ──');
eq(pick(M.planIngredient(lls, 15, 'mL'), ['take', 'takeQty', 'takeUnit', 'after']), { take: true, takeQty: 1, takeUnit: 'tube', after: 3 }, '15 mL = one whole tube: taken');
eq(pick(M.planIngredient(lls, 30, 'mL'), ['takeQty']), { takeQty: 2 }, '30 mL = two tubes');
eq(pick(M.planIngredient(lls, 0.015, 'L'), ['takeQty']), { takeQty: 1 }, '0.015 L = one tube');
p = M.planIngredient(lls, 7, 'mL');
eq(pick(p, ['take', 'reason']), { take: false, reason: 'part' }, '7 mL is part of a tube: noted');
ok(/when a tube is finished/.test(p.text), 'and says when the count will move: ' + p.text);
eq(pick(M.planIngredient(lls, 2, 'tube'), ['take', 'takeQty', 'after']), { take: true, takeQty: 2, after: 2 }, 'two whole tubes: taken');
eq(M.planIngredient(lls, 3, 'g').take, false, 'grams against tubes of mL: noted');

console.log('── untracked: only whole packages, only on purpose ──');
eq(pick(M.planIngredient(dmem, 2, 'piece'), ['take', 'reason']), { take: false, reason: 'untracked' }, 'pieces of an untracked item: noted');
eq(pick(M.planIngredient(dmem, 50, 'mL'), ['take', 'reason']), { take: false, reason: 'untracked' }, 'mL of an untracked item: noted');
eq(pick(M.planIngredient(dmem, 2, 'package'), ['take', 'via', 'before', 'after']), { take: true, via: 'legacy', before: 3, after: 1 }, 'two whole packages off the Qty column');
eq(pick(M.planIngredient(dmem, 5, 'package'), ['after', 'over']), { after: 0, over: true }, 'never below zero on the Qty column');
ok(!!M.planIngredient(dmem, 1.5, 'package').error, 'half a package: refused');
eq(M.planIngredient(pbs, 1, 'package').take, false, 'no Qty: nothing to take');

console.log('── errors ──');
ok(!!M.planIngredient(fbs, 0, 'mL').error && !!M.planIngredient(fbs, '', 'mL').error, 'no amount');
ok(!!M.planIngredient(fbs, 5, '').error, 'no unit');

console.log('── the item that gets made ──');
const who = { uid: 'u1', name: 'Test User' };
let doc = M.buildItem({ type: 'material', name: ' LLS 100 µm, rhodamine ', description: ' beads ', location: ' fridge / box / 001 ', count: '4', unit: 'tube', each_amount: '15', each_unit: 'mL', made_on: '2026-10-23' }, who, '2026-10-24');
eq(pick(doc, ['id', 'name', 'description', 'category', 'subcategory', 'lab_made', 'lab_made_type', 'made_by_uid', 'made_by_name', 'date_acquired']),
   { id: 'material-2026-10-23-lls-100-m-rhodamine', name: 'LLS 100 µm, rhodamine', description: 'beads', category: 'lab_made', subcategory: 'custom_material', lab_made: true, lab_made_type: 'material', made_by_uid: 'u1', made_by_name: 'Test User', date_acquired: '2026-10-23' },
   'a custom material, named and described as typed');
eq(pick(doc, ['qty_tracked', 'qty_unit', 'qty_made', 'qty_remaining', 'quantity', 'each_amount', 'each_unit']), { qty_tracked: true, qty_unit: 'tube', qty_made: 4, qty_remaining: 4, quantity: 4, each_amount: 15, each_unit: 'mL' },
   'a group: counted in tubes, each holds 15 mL');
eq(doc.locations, [{ name: 'fridge/box/001', quantity: 4, notes: '' }], 'one location for the whole group, slashes tidied');
eq([doc.is_consumable, doc.composition, doc.vendor, doc.reorder], [true, [], '', null], 'consumable, recipe filled in later, no vendor, no reorder');
doc = M.buildItem({ type: 'media', name: 'DMEM + 10% FBS', description: 'x', location: 'fridge 2', count: '500', unit: 'mL', each_amount: '9', each_unit: 'mL' }, who, '2026-10-24');
eq(pick(doc, ['qty_unit', 'qty_made', 'each_amount', 'date_acquired', 'subcategory']), { qty_unit: 'mL', qty_made: 500, each_amount: undefined, date_acquired: '2026-10-24', subcategory: 'custom_media' }, 'media counted in mL: no "each", made today');
doc = M.buildItem({ type: 'aliquot', name: 'Matrigel 200 µL', description: 'x', location: 'freezer', count: '', unit: 'tube' }, who, '2026-10-24');
eq([doc.qty_tracked, doc.quantity, doc.locations[0].quantity], [undefined, null, null], 'no count: listed, not counted');
eq(M.buildItem({ type: 'aliquot', name: 'a', description: 'x', location: 'y', count: '2.6', unit: 'tube' }, who, 'd').qty_made, 3, 'containers are whole');
eq(M.buildItem({ type: 'bogus', name: 'a', description: 'x', location: 'y' }, who, 'd').lab_made_type, 'aliquot', 'an unknown kind falls back to aliquot');

console.log('── labels, the group line, validation ──');
eq([M.labelCount({ print: true, count: 4, unit: 'tube' }), M.labelCount({ print: true, count: 500, unit: 'mL' }), M.labelCount({ print: true, count: 300, unit: 'tube' }), M.labelCount({ print: false, count: 4, unit: 'tube' }), M.labelCount({ print: true, count: '', unit: 'tube' })],
   [4, 1, 100, 0, 1], 'one label per tube (capped at 100); one for a measure or no count; none when not printing');
eq(M.groupLine({ count: 4, unit: 'tube', each_amount: 15, each_unit: 'mL', location: 'fridge/box/001' }), '4 tubes of 15 mL each, together at fridge/box/001; the same QR code goes on every tube.', 'the group line');
eq(M.groupLine({ count: 500, unit: 'mL', location: 'fridge 2' }), '500 mL at fridge 2, one QR code.', 'a measure');
eq(M.groupLine({ count: 1, unit: 'bottle' }), '1 bottle.', 'one container');
const errs = M.validate({ type: '', name: ' ', description: '', location: ' / ', count: 'x', each_amount: '15' }, [{ plan: { error: 'How much did you use?' } }]);
eq(errs.map(e => e.field), ['type', 'name', 'description', 'location', 'count', 'count', 'from'], 'every missing field, a bad count, a size with no count, a bad row');
eq(M.validate({ type: 'aliquot', name: 'a', description: 'b', location: 'c', count: '4' }, []), [], 'a complete form passes');

console.log('── the recipe line, search, locations ──');
eq(M.compositionEntry(fbs, M.planIngredient(fbs, 50, 'mL')), { itemId: 'fbs', name: 'FBS', kind: 'item', qty: 50, unit: 'mL', taken: true, taken_qty: 50, taken_unit: 'mL', note: '' }, 'a taken line');
eq(M.compositionEntry(tubesPack, M.planIngredient(tubesPack, 4, 'piece')), { itemId: 'conical-15', name: 'Conical tubes 15 mL, pack of 50', kind: 'item', qty: 4, unit: 'piece', taken: false, taken_qty: 0, taken_unit: '', note: 'pieces' }, 'a noted line keeps what was said');
const pool = [fbs, matrigel, tubesPack, tubesEa, { id: 'old', name: 'FBS old lot', condition: 'retired' }, { id: 'fbs-hi', name: 'Heat-inactivated FBS', vendor: 'Gibco' }];
eq(M.search(pool, 'fbs', 8).map(i => i.id), ['fbs', 'fbs-hi'], 'name-prefix first, retired left out');
eq(M.search(pool, 'conical 15', 8, ['conical-15']).map(i => i.id), ['conical-15-ea'], 'every word must match; already-added rows skipped');
eq(M.search(pool, 'gibco', 8).map(i => i.id), ['fbs-hi'], 'vendor matches');
eq(M.search(pool, '', 8), [], 'nothing typed, nothing listed');
eq(M.locationNames([{ locations: [{ name: 'Fridge / Box 1' }, { name: 'bench' }] }, { locations: [{ name: 'fridge/box 1' }] }]), ['bench', 'Fridge/Box 1'], 'locations tidied and deduped case-blind');
eq([M.stockText(fbs), M.stockText(dmem), M.stockText(pbs)], ['counted in mL · 450 left', 'not counted (Qty 3)', 'not counted'], 'how each is counted, in words');

console.log(`inventory-made: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
