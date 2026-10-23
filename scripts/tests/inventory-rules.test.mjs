/* Scannable-inventory (V3.646) firestore.rules stress test.
 *
 * The quantity invariant is the reason this file exists: ANY lab member may
 * DECREASE qty_remaining (a consumption event) but only a manager may raise it
 * or set an absolute value (a recount — the auditable act). Get that wrong in
 * either direction and you either block every student from recording what they
 * took, or let anyone forge how much is left.
 *
 * Setup + run (same harness as teacher-rules.test.mjs):
 *   npm install --legacy-peer-deps @firebase/rules-unit-testing@4 firebase@11
 *   JAVA_HOME=<a JDK 21+> PATH=$JAVA_HOME/bin:$PATH \
 *     firebase emulators:exec --only firestore --project demo-mcgheelab-inv \
 *     "node inventory-rules.test.mjs"
 *
 * Java 21+ required (firebase-tools 15 rejects older JDKs; this machine's
 * system JDK is 8, so JAVA_HOME must point somewhere else).
 *
 * Output marks:
 *   ok    — behaves as the V3.646 plan intends
 *   HOLE  — succeeded when it should have been denied
 *   BREAK — denied when a legitimate user needs it to work
 */
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { readFileSync } from 'node:fs';
import {
  doc, setDoc, getDoc, updateDoc, deleteDoc, addDoc, collection, setLogLevel
} from 'firebase/firestore';

setLogLevel('silent');   // expected PERMISSION_DENIEDs are the point, not noise

const RULES = new URL('../../firestore.rules', import.meta.url).pathname;

const env = await initializeTestEnvironment({
  projectId: 'demo-mcgheelab-inv',
  firestore: { rules: readFileSync(RULES, 'utf8'), host: '127.0.0.1', port: 8199 }
});

let ok = 0, holes = 0, breaks = 0;
async function mustAllow(name, fn) {
  try { await fn(); console.log('  ok    ' + name); ok++; }
  catch (e) { console.log('  BREAK ' + name); breaks++; }
}
async function mustDeny(name, fn) {
  try { await fn(); console.log('  HOLE  ' + name); holes++; }
  catch (e) { console.log('  ok    ' + name); ok++; }
}

/* ── personas ── */
const member  = env.authenticatedContext('member').firestore();
const member2 = env.authenticatedContext('member2').firestore();
const mgr     = env.authenticatedContext('mgr').firestore();      // cap, not admin
const admin   = env.authenticatedContext('admin').firestore();
const guest   = env.authenticatedContext('guest').firestore();

/* ── seed the docs the rule helpers read ── */
await env.withSecurityRulesDisabled(async (ctx) => {
  const d = ctx.firestore();
  await setDoc(doc(d, 'users/member'),  { role: 'editor' });
  await setDoc(doc(d, 'users/member2'), { role: 'editor' });
  await setDoc(doc(d, 'users/mgr'),     { role: 'editor' });
  await setDoc(doc(d, 'users/admin'),   { role: 'admin'  });
  await setDoc(doc(d, 'users/guest'),   { role: 'guest'  });
  await setDoc(doc(d, 'userPermissions/mgr'), { caps: ['inventory:manage'] });

  // The ~740-of-777 case: a legacy item with no qty_* fields at all.
  await setDoc(doc(d, 'inventory/legacy'), {
    kind: 'item', name: 'Legacy tubes', quantity: 3, stock_status: 'full' });
  await setDoc(doc(d, 'inventory/tracked'), {
    kind: 'item', name: 'Tracked buffer', qty_tracked: true, qty_unit: 'mL',
    qty_made: 500, qty_remaining: 500, qty_min: 100, stock_status: 'full' });
  await setDoc(doc(d, 'inventory/tracked2'), {
    kind: 'item', name: 'T2', qty_tracked: true, qty_unit: 'mL',
    qty_made: 500, qty_remaining: 500, qty_min: null, stock_status: 'full' });
  await setDoc(doc(d, 'inventory/otherStock'), {
    kind: 'stock', ownerUid: 'member2', qty_tracked: true,
    qty_made: 1, qty_remaining: 1, qty_unit: 'mL' });
  await setDoc(doc(d, 'labels/MG-AAAAA'), {
    code: 'MG-AAAAA', boundBy: 'member', target_kind: 'item', target_id: 'legacy' });
  await setDoc(doc(d, 'inventoryLocations/box4'), {
    kind: 'box', name: 'Box 4', parentId: 'freezer1', createdBy: 'member' });
  await setDoc(doc(d, 'inventoryUsage/frozen'), {
    itemId: 'x', event: 'use', qty: 1, delta: -1, before: 2, after: 1, userUid: 'member' });
});

console.log('\n── inventory: the quantity invariant ──');
// The legacy path. If this BREAKs, every existing inline editor on the
// inventory page stops saving for ~740 items.
await mustAllow('legacy item: member edits an unrelated field, omitting qty_remaining',
  () => updateDoc(doc(member, 'inventory/legacy'), { subcategory: 'tubes' }));
await mustAllow('member DECREASES 500 → 450 (a consumption event)',
  () => updateDoc(doc(member, 'inventory/tracked'), { qty_remaining: 450 }));
await mustDeny('member RAISES 450 → 500',
  () => updateDoc(doc(member, 'inventory/tracked'), { qty_remaining: 500 }));
await mustAllow('manager (cap, not admin) raises 450 → 500',
  () => updateDoc(doc(mgr, 'inventory/tracked'), { qty_remaining: 500 }));
await mustAllow('admin raises without holding the cap',
  () => updateDoc(doc(admin, 'inventory/tracked'), { qty_remaining: 600 }));
// The other three ways to fake "there is more than there is".
await mustDeny('member lowers qty_min',
  () => updateDoc(doc(member, 'inventory/tracked'), { qty_min: 0 }));
await mustDeny('member inflates qty_made',
  () => updateDoc(doc(member, 'inventory/tracked'), { qty_made: 9999 }));
await mustDeny('member swaps qty_unit mL → L',
  () => updateDoc(doc(member, 'inventory/tracked'), { qty_unit: 'L' }));
await mustDeny('member turns qty_tracked OFF',
  () => updateDoc(doc(member, 'inventory/tracked'), { qty_tracked: false }));
// Without `is number` on both sides, '10' <= '5' compares lexicographically
// and is TRUE — a string would sail straight through.
await mustDeny('member writes qty_remaining as the STRING "5"',
  () => updateDoc(doc(member, 'inventory/tracked'), { qty_remaining: '5' }));
// qtyNotRaised() alone cannot catch this: a dropped field makes qtyAfter()
// fall back to the resource's own value and compare equal.
await mustDeny('member DROPS qty_remaining via non-merge set, keeping the controls',
  () => setDoc(doc(member, 'inventory/tracked2'), {
    kind: 'item', name: 'T2', qty_tracked: true, qty_unit: 'mL',
    qty_made: 500, qty_min: null, stock_status: 'full' }));
await mustDeny('guest reads inventory', () => getDoc(doc(guest, 'inventory/tracked')));

console.log('\n── inventory: stock batches ──');
await mustAllow('member creates a batch signed with their own uid',
  () => setDoc(doc(member, 'inventory/stk1'), {
    kind: 'stock', name: 'LLS 100um rhodamine + FITC beads', ownerUid: 'member',
    qty_tracked: true, qty_made: 40, qty_remaining: 40, qty_unit: 'mL' }));
await mustDeny('member creates a batch owned by someone else',
  () => setDoc(doc(member, 'inventory/stk2'), {
    kind: 'stock', name: 'X', ownerUid: 'member2',
    qty_tracked: true, qty_made: 40, qty_remaining: 40, qty_unit: 'mL' }));
await mustDeny('batch claiming remaining > made',
  () => setDoc(doc(member, 'inventory/stk3'), {
    kind: 'stock', name: 'X', ownerUid: 'member',
    qty_tracked: true, qty_made: 40, qty_remaining: 99, qty_unit: 'mL' }));
await mustDeny('batch created without a unit',
  () => setDoc(doc(member, 'inventory/stk5'), {
    kind: 'stock', name: 'X', ownerUid: 'member',
    qty_tracked: true, qty_made: 40, qty_remaining: 40 }));
await mustAllow('the maker deletes their own batch (a mis-entry is their own mess)',
  () => deleteDoc(doc(member, 'inventory/stk1')));
await mustDeny('a member deletes someone else’s batch',
  () => deleteDoc(doc(member, 'inventory/otherStock')));
await mustDeny('a member deletes a plain item (admin only)',
  () => deleteDoc(doc(member, 'inventory/legacy')));

console.log('\n── inventoryUsage: append-only ledger ──');
await mustAllow('valid consumption row',
  () => addDoc(collection(member, 'inventoryUsage'), {
    itemId: 'tracked', itemKind: 'item', event: 'use',
    qty: 50, delta: -50, before: 500, after: 450, unit: 'mL', userUid: 'member' }));
// A mL/uL ledger is floating point: 0.1 + 0.2 !== 0.3, so an exact ==
// consistency check would silently deny a few percent of real writes.
await mustAllow('float row survives the epsilon (the 0.1 + 0.2 case)',
  () => addDoc(collection(member, 'inventoryUsage'), {
    itemId: 'tracked', event: 'use',
    qty: 0.2, delta: -0.2, before: 0.3, after: 0.1, unit: 'mL', userUid: 'member' }));
await mustDeny('row where before + delta != after',
  () => addDoc(collection(member, 'inventoryUsage'), {
    itemId: 'tracked', event: 'use',
    qty: 50, delta: -50, before: 500, after: 999, unit: 'mL', userUid: 'member' }));
await mustDeny('member writes a POSITIVE delta (adding stock)',
  () => addDoc(collection(member, 'inventoryUsage'), {
    itemId: 'tracked', event: 'add',
    qty: 50, delta: 50, before: 450, after: 500, unit: 'mL', userUid: 'member' }));
await mustAllow('manager writes a recount row',
  () => addDoc(collection(mgr, 'inventoryUsage'), {
    itemId: 'tracked', event: 'recount',
    qty: 500, delta: 50, before: 450, after: 500, unit: 'mL', userUid: 'mgr' }));
await mustDeny('row signed with someone else’s uid',
  () => addDoc(collection(member, 'inventoryUsage'), {
    itemId: 'tracked', event: 'use',
    qty: 1, delta: -1, before: 5, after: 4, unit: 'mL', userUid: 'member2' }));
await mustDeny('an unknown event kind',
  () => addDoc(collection(member, 'inventoryUsage'), {
    itemId: 'tracked', event: 'teleport',
    qty: 1, delta: -1, before: 5, after: 4, unit: 'mL', userUid: 'member' }));
// Immutability IS the audit guarantee — before/after chaining only proves
// anything if history cannot be rewritten.
await mustDeny('admin edits history', () => updateDoc(doc(admin, 'inventoryUsage/frozen'), { qty: 99 }));
await mustDeny('admin deletes history', () => deleteDoc(doc(admin, 'inventoryUsage/frozen')));

console.log('\n── labels: create-only reservation ──');
await mustAllow('binding a fresh code',
  () => setDoc(doc(member, 'labels/MG-BBBBB'), {
    code: 'MG-BBBBB', boundBy: 'member', target_kind: 'stock', target_id: 'stk1' }));
// This is the whole reservation mechanism: `create` fires only when the doc
// does not exist, so the loser's set() is judged as an `update` and refused.
await mustDeny('a racing second binder on the SAME code',
  () => setDoc(doc(member2, 'labels/MG-BBBBB'), {
    code: 'MG-BBBBB', boundBy: 'member2', target_kind: 'item', target_id: 'legacy' }));
await mustDeny('code field not matching the doc id',
  () => setDoc(doc(member, 'labels/MG-CCCCC'), {
    code: 'MG-DDDDD', boundBy: 'member', target_kind: 'item' }));
await mustDeny('an unknown target_kind',
  () => setDoc(doc(member, 'labels/MG-EEEEE'), {
    code: 'MG-EEEEE', boundBy: 'member', target_kind: 'wormhole' }));
await mustAllow('a reserved-but-unbound code (a printed sheet of blanks)',
  () => setDoc(doc(member, 'labels/MG-FFFFF'), {
    code: 'MG-FFFFF', boundBy: 'member', target_kind: '' }));
await mustAllow('the binder re-binds their own label',
  () => updateDoc(doc(member, 'labels/MG-BBBBB'), { target_id: 'other' }));
await mustDeny('a stranger re-binds someone else’s label',
  () => updateDoc(doc(member2, 'labels/MG-BBBBB'), { target_id: 'hijack' }));
await mustAllow('a manager re-binds any label',
  () => updateDoc(doc(mgr, 'labels/MG-BBBBB'), { target_id: 'fixed' }));
// A deleted code is a code that can be re-minted onto a DIFFERENT tube —
// the one failure this registry exists to prevent.
await mustDeny('a code is deleted, even by admin', () => deleteDoc(doc(admin, 'labels/MG-BBBBB')));

console.log('\n── inventoryLocations: boxes ──');
await mustAllow('a member renames a box',
  () => updateDoc(doc(member, 'inventoryLocations/box4'), { name: 'Box 4A' }));
await mustDeny('a member re-parents a box (it relocates other people’s things)',
  () => updateDoc(doc(member, 'inventoryLocations/box4'), { parentId: 'freezer2' }));
await mustDeny('a member retires a box',
  () => updateDoc(doc(member, 'inventoryLocations/box4'), { retired: true }));
await mustAllow('a manager re-parents a box',
  () => updateDoc(doc(mgr, 'inventoryLocations/box4'), { parentId: 'freezer2' }));
await mustDeny('a member deletes a box (admin only)',
  () => deleteDoc(doc(member, 'inventoryLocations/box4')));

console.log('\n── labelQueue: print from anywhere ──');
await mustAllow('a member queues a job for themselves',
  () => addDoc(collection(member, 'labelQueue'), {
    requestedBy: 'member', status: 'queued', cells: [{ reagent: 'X' }] }));
await mustDeny('an empty job',
  () => addDoc(collection(member, 'labelQueue'), {
    requestedBy: 'member', status: 'queued', cells: [] }));
await mustDeny('queueing on someone else’s behalf',
  () => addDoc(collection(member, 'labelQueue'), {
    requestedBy: 'member2', status: 'queued', cells: [{ reagent: 'X' }] }));
await mustDeny('a job created already marked printed',
  () => addDoc(collection(member, 'labelQueue'), {
    requestedBy: 'member', status: 'printed', cells: [{ reagent: 'X' }] }));

console.log('\n── labInitials: uniqueness ──');
await mustAllow('claiming free initials',
  () => setDoc(doc(member, 'labInitials/AM'), { uid: 'member', claimedAt: 'x' }));
await mustDeny('claiming initials somebody already holds',
  () => setDoc(doc(member2, 'labInitials/AM'), { uid: 'member2', claimedAt: 'x' }));
await mustDeny('claiming initials on behalf of another uid',
  () => setDoc(doc(member, 'labInitials/XY'), { uid: 'member2', claimedAt: 'x' }));

console.log('\n── V3.834: scan-to-use ──');
// use_mode is a manager's designation (qtyControlsUnchanged), like switching tracking on.
await mustDeny('member designates use_mode on a tracked item',
  () => updateDoc(doc(member, 'inventory/tracked'), { use_mode: 'per_use' }));
await mustDeny('member designates use_mode on a legacy item',
  () => updateDoc(doc(member, 'inventory/legacy'), { use_mode: 'package' }));
await mustAllow('manager (cap) designates use_mode',
  () => updateDoc(doc(mgr, 'inventory/tracked'), { use_mode: 'per_use' }));
await mustAllow('admin designates use_mode',
  () => updateDoc(doc(admin, 'inventory/legacy'), { use_mode: 'package' }));
await mustAllow('member still edits another field once use_mode is set (omitted → unchanged)',
  () => updateDoc(doc(member, 'inventory/tracked'), { notes: 'opened 10/22' }));
await mustDeny('member clears a designated use_mode',
  () => updateDoc(doc(member, 'inventory/tracked'), { use_mode: '' }));
// The per-use log: a ledger row that moves nothing (delta 0) is a member's own act.
await mustAllow('member logs one USE (delta 0, before == after)',
  () => addDoc(collection(member, 'inventoryUsage'), {
    itemId: 'tracked', event: 'use', qty: 1, unit: 'use', delta: 0, before: 450, after: 450, userUid: 'member', useMode: 'per_use' }));
await mustAllow('member takes a package off an untracked item (legacy row, delta -1)',
  () => addDoc(collection(member, 'inventoryUsage'), {
    itemId: 'legacy', event: 'use', qty: 1, unit: 'ea', delta: -1, before: 3, after: 2, userUid: 'member', legacy: true }));
await mustAllow('member writes the legacy quantity down and use_count up in the same act',
  () => updateDoc(doc(member, 'inventory/legacy'), { quantity: 2, use_count: 1, last_used_by: 'member' }));
await mustAllow('member binds a label code onto an item (label_code is not a control)',
  () => updateDoc(doc(member, 'inventory/legacy'), { label_code: 'MG-AAAAA' }));

await env.cleanup();
const bad = holes + breaks;
console.log('\n' + ok + ' ok, ' + holes + ' HOLE, ' + breaks + ' BREAK');
process.exit(bad ? 1 : 0);
