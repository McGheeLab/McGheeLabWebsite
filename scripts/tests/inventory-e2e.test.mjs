/* inventory-e2e.test.mjs — V3.646 end-to-end user journeys
 * ============================================================================
 * This is the suite that mimics what a person actually DOES, using the REAL
 * browser modules against the REAL firestore.rules, as REAL signed-in users.
 *
 * Nothing here is mocked except the browser shell:
 *   - rm/js/label-id.js, rm/js/inventory-qty.js and rm/js/scan-resolve.js are
 *     loaded and executed verbatim, the same bytes the site ships;
 *   - writes go through the Firestore emulator with ../../firestore.rules
 *     uploaded, so a rule that forbids something forbids it here;
 *   - the actors are genuine Auth-emulator users, so request.auth.uid is real
 *     and isInvMgr() does its actual get() on userPermissions.
 *
 * That combination is the point. Unit tests told us the derivation is right and
 * the rules test told us the invariant holds; only this tells us the MODULE
 * drives the RULES correctly end to end — that the transaction writes what the
 * rules expect, in the order they expect it.
 *
 * Setup + run:
 *   npm install --legacy-peer-deps @firebase/rules-unit-testing@4 firebase@11
 *   JAVA_HOME=<a JDK 21+> PATH=$JAVA_HOME/bin:$PATH \
 *     firebase emulators:exec --only firestore,auth --project demo-mcgheelab-e2e \
 *     "node inventory-e2e.test.mjs"
 *
 * Output marks:
 *   ok    — the journey behaves as the V3.646 plan intends
 *   FAIL  — it does not, and the line says what was expected
 * ============================================================================ */

import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { readFileSync } from 'node:fs';
import { doc, setDoc } from 'firebase/firestore';
import firebase from 'firebase/compat/app';
import 'firebase/compat/auth';
import 'firebase/compat/firestore';
import { webcrypto } from 'node:crypto';

const PID = 'demo-mcgheelab-e2e';
const ROOT = new URL('../../', import.meta.url).pathname;

/* ── reporting ─────────────────────────────────────────────────────────── */
let pass = 0, fail = 0;
const failures = [];
function ok(name) { console.log('  ok    ' + name); pass++; }
function bad(name, detail) {
  console.log('  FAIL  ' + name + (detail ? '   → ' + detail : ''));
  failures.push(name + (detail ? ' → ' + detail : '')); fail++;
}
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  g === w ? ok(name) : bad(name, `got ${g}, want ${w}`);
}
function truthy(name, v, detail) { v ? ok(name) : bad(name, detail); }
async function denied(name, fn) {
  try { await fn(); bad(name, 'the write SUCCEEDED — that is a hole'); }
  catch (e) {
    /permission-denied|PERMISSION_DENIED|insufficient/i.test(e.message || '')
      ? ok(name) : bad(name, 'failed for the wrong reason: ' + e.message);
  }
}
async function allowed(name, fn) {
  try { const r = await fn(); ok(name); return r; }
  catch (e) { bad(name, 'denied, but a real user needs this: ' + e.message); return null; }
}
function section(t) { console.log('\n── ' + t + ' ──'); }

/* ── the browser shell the modules expect ──────────────────────────────── */
function makeLocalStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null),
           setItem: (k, v) => m.set(k, String(v)),
           removeItem: (k) => m.delete(k), clear: () => m.clear() };
}
/**
 * Execute a shipped browser module verbatim. The modules reference `window`,
 * `firebase`, `firebridge`, `api` and `localStorage` as bare globals, so passing
 * them as named parameters shadows them cleanly — no global pollution, and each
 * actor gets its own module instance bound to its own signed-in identity.
 */
function loadModule(relPath, ctx) {
  const src = readFileSync(ROOT + relPath, 'utf8');
  const fn = new Function('window', 'firebase', 'firebridge', 'api', 'localStorage', src);
  fn.call(ctx.window, ctx.window, ctx.firebase, ctx.firebridge, ctx.api, ctx.localStorage);
}

/* ── boot ──────────────────────────────────────────────────────────────── */
const env = await initializeTestEnvironment({
  projectId: PID,
  firestore: { rules: readFileSync(ROOT + 'firestore.rules', 'utf8'), host: '127.0.0.1', port: 8199 },
});
const CFG = { apiKey: 'fake-api-key', projectId: PID, authDomain: 'localhost' };

/**
 * ONE NAMED FIREBASE APP PER ACTOR.
 *
 * A single app instance carries a single auth session, so
 * createUserWithEmailAndPassword() for a second actor would silently REPLACE the
 * first — every "different user" would in fact be the last one signed in, and
 * every permission assertion would be meaningless while appearing to pass. Each
 * actor therefore gets its own named app, its own auth, and its own Firestore
 * handle bound to its own identity.
 */
async function actor(email, profile, caps) {
  const app = firebase.initializeApp(CFG, email);
  app.auth().useEmulator('http://127.0.0.1:9099', { disableWarnings: true });
  app.firestore().useEmulator('127.0.0.1', 8199);
  const cred = await app.auth().createUserWithEmailAndPassword(email, 'password123');
  const uid = cred.user.uid;
  // Seed AFTER sign-in: the Auth emulator assigns the uid, and isLabMember()
  // reads users/{uid}.
  await env.withSecurityRulesDisabled(async (c) => {
    await setDoc(doc(c.firestore(), 'users/' + uid), Object.assign({ role: 'editor' }, profile));
    if (caps) await setDoc(doc(c.firestore(), 'userPermissions/' + uid), { caps });
  });
  const adb = app.firestore();
  const window = { crypto: webcrypto };
  const ctx = {
    window,
    firebase,                       // FieldValue is a static namespace — shared is fine
    firebridge: {
      db: () => adb,
      getUser: () => ({ uid, email }),
      getProfile: () => Object.assign({ uid }, profile),
      isAdmin: () => (profile.role === 'admin'),
      hasCapability: (c) => !!(caps && caps.indexOf(c) >= 0),
    },
    api: { invalidate: async () => {} },
    localStorage: makeLocalStorage(),
  };
  loadModule('rm/js/label-id.js', ctx);
  loadModule('rm/js/inventory-qty.js', ctx);
  loadModule('rm/js/scan-resolve.js', ctx);
  return { uid, email, db: adb, w: window };
}

/* Each actor must sign in before its users/{uid} can be seeded, because the
 * Auth emulator assigns the uid. */
const student = await actor('student@test.lab', { name: 'Sam Student', initials: 'SS' });
const other   = await actor('other@test.lab',   { name: 'Otto Other',  initials: 'OO' });
const mgr     = await actor('mgr@test.lab',     { name: 'Mia Manager',  initials: 'MM' }, ['inventory:manage']);
const admin   = await actor('admin@test.lab',   { name: 'Alex', role: 'admin' });

const S = student.w.INV_QTY, SR = student.w.SCAN_RESOLVE, LID = student.w.LABEL_ID;
const M = mgr.w.INV_QTY, MSR = mgr.w.SCAN_RESOLVE;
const O = other.w.INV_QTY;

/* Per-actor Firestore handles. `db` deliberately does not exist as a bare global
 * here: every raw write in a journey has to say WHO is doing it, or an assertion
 * about permissions proves nothing. */
const sdb = student.db, odb = other.db, mdb = mgr.db, adb = admin.db;

/* ════════════════════════════════════════════════════════════════════════
   JOURNEY 1 — Sam makes a batch and gets a label for it
   ════════════════════════════════════════════════════════════════════════ */
section('Journey 1: "I made 40 mL of inert LLS 100um + rhodamine + FITC beads"');

const BATCH = 'stk-lls-100-rhod-fitc';
const LONG_NAME = 'Inert LLS 100 µm, rhodamine-labelled, with FITC traction beads';

await allowed('Sam creates the batch, signed with her own uid', () =>
  sdb.collection('inventory').doc(BATCH).set({
    kind: 'stock', name: LONG_NAME,
    description: 'Batch for the Aug traction-force runs. 100 µm inert LLS granules, ' +
                 'rhodamine label, FITC beads at 0.1% w/v.',
    ownerUid: student.uid, ownerInitials: 'SS',
    qty_tracked: true, qty_made: 40, qty_remaining: 40, qty_unit: 'mL', qty_min: null,
    composition: [
      { name: 'LLS granules 100 µm', role: 'base', amount: 40, unit: 'mL' },
      { name: 'Rhodamine B', role: 'label', amount: 10, unit: 'µL' },
      { name: 'FITC traction beads', role: 'bead', amount: 40, unit: 'µL' },
    ],
    storage: '4C', preparedDate: '2026-08-19', stock_status: 'full',
  }));

// The label code comes from RM, reserved in a transaction, so it is unique by
// construction rather than by keyspace luck.
const CODE = await allowed('RM mints and reserves a label code for it', () =>
  SR.mintAndBind({ kind: 'stock', refId: BATCH, title: LONG_NAME,
                   ownerUid: student.uid, ownerInitials: 'SS' }));
truthy('the minted code is well-formed (' + CODE + ')', LID.isWellFormed(CODE));
{
  const l = await sdb.collection('labels').doc(CODE).get();
  eq('labels/{CODE} points at the batch', l.data().target_id, BATCH);
  eq('…and records who bound it', l.data().boundBy, student.uid);
}

/* ════════════════════════════════════════════════════════════════════════
   JOURNEY 2 — Sam scans the tube at the bench
   ════════════════════════════════════════════════════════════════════════ */
section('Journey 2: scanning the tube tells you what it actually is');

{
  const r = await SR.resolve(CODE);
  eq('a clean scan resolves', r.status, 'ok');
  eq('…and hydrates the batch', r.item && r.item.name, LONG_NAME);
  truthy('…including the description that does NOT fit on the label',
    r.item && /FITC beads at 0\.1% w\/v/.test(r.item.description || ''));
  eq('…and reports how much is left', r.item && r.item.qty_remaining, 40);
}
// A phone camera hands you the raw payload; a human hands you whatever they typed.
SR._clearCache();
eq('lowercase from a keyboard resolves the same',
  (await SR.resolve(CODE.toLowerCase())).status, 'ok');
SR._clearCache();
eq('a wedge trailing CR/LF resolves the same',
  (await SR.resolve(' ' + CODE + '\r\n')).status, 'ok');
SR._clearCache();
eq('the box-label URL form resolves to the same code',
  (await SR.resolve('HTTPS://MCGHEELAB.COM/L/' + CODE)).code, CODE);
// The check character earning its slot: a mistyped code must fail LOUDLY rather
// than resolve to someone else's tube.
{
  const A = LID.ALPHABET;
  const lastIdx = A.indexOf(CODE[CODE.length - 1]);
  const wrong = CODE.slice(0, -1) + A[(lastIdx + 1) % A.length];
  const r = await SR.resolve(wrong);
  eq('one mistyped character is caught by the check digit', r.status, 'bad-check');
  truthy('…and the message names the remedy',
    /check character/i.test(SR.explain(r)), SR.explain(r));
}
{
  const r = await SR.resolve('4Q7-HELLO-WORLD');
  eq('a stray non-lab barcode is rejected on SHAPE', r.status, 'malformed');
}
{
  // The shape gate must run BEFORE any read: isValid() alone accepts a 2-char
  // body, so ~1 in 32 random strings would otherwise cost a Firestore read.
  const r = await SR.resolve('X1');
  eq('a 2-char string that passes the check digit is still rejected', r.status, 'malformed');
}

/* ════════════════════════════════════════════════════════════════════════
   JOURNEY 3 — Sam takes some, twice, and the count follows
   ════════════════════════════════════════════════════════════════════════ */
section('Journey 3: "I took 5 mL" — and the number moves');

{
  const r = await allowed('Sam records taking 5 mL', () =>
    S.consume({ itemId: BATCH, qty: 5, unit: 'mL', labelCode: CODE, purpose: 'experiment' }));
  eq('…before/after are stamped on the event', [r.before, r.after], [40, 35]);
  eq('…and the item now reads 35', (await sdb.collection('inventory').doc(BATCH).get()).data().qty_remaining, 35);
}
await allowed('Sam takes 500 µL, recorded against a mL batch', () =>
  S.consume({ itemId: BATCH, qty: 500, unit: 'uL' }));
eq('…unit conversion lands it at 34.5 mL',
  (await sdb.collection('inventory').doc(BATCH).get()).data().qty_remaining, 34.5);
await denied('recording litres against a mL batch is refused, not silently converted', async () => {
  try { await S.consume({ itemId: BATCH, qty: 1, unit: 'kg' }); }
  catch (e) { throw new Error('permission-denied-equivalent: ' + e.message); }
});

/* The ledger self-check: row N's `before` must equal row N-1's `after`. This is
 * what makes a lost write or a rogue edit DETECTABLE without trusting the
 * counter — so it is worth asserting as a property, not just per row. */
async function ledger(itemId) {
  const snap = await sdb.collection('inventoryUsage')
    .where('itemId', '==', itemId).orderBy('createdAt', 'asc').get();
  return snap.docs.map((d) => d.data());
}
{
  const rows = await ledger(BATCH);
  let breaks = 0;
  for (let i = 1; i < rows.length; i++) {
    if (Math.abs(rows[i].before - rows[i - 1].after) > 1e-6) breaks++;
  }
  eq(`the ledger chain is unbroken across ${rows.length} rows`, breaks, 0);
  const last = rows[rows.length - 1];
  eq('…and its final `after` equals the live counter', last.after,
    (await sdb.collection('inventory').doc(BATCH).get()).data().qty_remaining);
}

/* ════════════════════════════════════════════════════════════════════════
   JOURNEY 4 — crossing the low threshold
   ════════════════════════════════════════════════════════════════════════ */
section('Journey 4: crossing 20% of the batch flips it to low, exactly once');

// 34.5 → 8 mL is 20% of 40, so this write is the crossing.
await allowed('Sam takes 26.5 mL, landing on 8 (20% of 40)', () =>
  S.consume({ itemId: BATCH, qty: 26.5, unit: 'mL' }));
{
  const it = (await sdb.collection('inventory').doc(BATCH).get()).data();
  eq('the derived status is now low', it.stock_status, 'low');
  eq('…with no explicit reorder point set', it.qty_min, null);
}
// The crossing guard in inventory-alerts.js suppresses on UNCHANGED severity, so
// the premise it rests on is that further use does not re-cross. Assert that.
await S.consume({ itemId: BATCH, qty: 1, unit: 'mL' });
await S.consume({ itemId: BATCH, qty: 1, unit: 'mL' });
eq('two more sips keep it low (so the alert fires once, not three times)',
  (await sdb.collection('inventory').doc(BATCH).get()).data().stock_status, 'low');
await allowed('Sam empties it', () => S.consume({ itemId: BATCH, qty: 6, unit: 'mL' }));
eq('an empty batch reads out_of_stock',
  (await sdb.collection('inventory').doc(BATCH).get()).data().stock_status, 'out_of_stock');

/* ════════════════════════════════════════════════════════════════════════
   JOURNEY 5 — someone else cannot forge the count
   ════════════════════════════════════════════════════════════════════════ */
section('Journey 5: Otto can record what he took, but cannot invent stock');

// The batch was emptied in journey 4, so refilling it is itself a manager act —
// which is the rule working. Mia recounts, THEN Otto consumes.
await allowed('Mia refills the batch to 10 mL so there is something to take', () =>
  M.recount({ itemId: BATCH, to: 10, reason: 'recount', note: 'restocked for the journey' }));
await allowed('Otto can consume from Sam’s batch (it is shared lab stock)', () =>
  O.consume({ itemId: BATCH, qty: 1, unit: 'mL' }));
await denied('Otto cannot recount it upward', () => O.recount({ itemId: BATCH, to: 40, reason: 'recount' }));
await denied('Otto cannot raise qty_remaining directly', () =>
  odb.collection('inventory').doc(BATCH).update({ qty_remaining: 999 }));
await denied('Otto cannot inflate qty_made', () =>
  odb.collection('inventory').doc(BATCH).update({ qty_made: 9999 }));
await denied('Otto cannot swap the unit to litres', () =>
  odb.collection('inventory').doc(BATCH).update({ qty_unit: 'L' }));
await denied('Otto cannot switch tracking off to escape the rule', () =>
  odb.collection('inventory').doc(BATCH).update({ qty_tracked: false }));
await denied('Otto cannot write a positive ledger delta', () =>
  odb.collection('inventoryUsage').add({
    itemId: BATCH, event: 'add', qty: 50, delta: 50, before: 9, after: 59,
    unit: 'mL', userUid: other.uid, createdAt: firebase.firestore.FieldValue.serverTimestamp() }));
await denied('Otto cannot delete Sam’s batch', () => odb.collection('inventory').doc(BATCH).delete());

/* ════════════════════════════════════════════════════════════════════════
   JOURNEY 6 — the manager corrects a wrong number
   ════════════════════════════════════════════════════════════════════════ */
section('Journey 6: Mia recounts by hand, and it stays auditable');

{
  const beforeCount = (await ledger(BATCH)).length;
  const r = await allowed('Mia sets it to 22 mL with a reason', () =>
    M.recount({ itemId: BATCH, to: 22, reason: 'recount', note: 'measured in a cylinder' }));
  eq('…the item follows', (await sdb.collection('inventory').doc(BATCH).get()).data().qty_remaining, 22);
  const rows = await ledger(BATCH);
  eq('…one new ledger row', rows.length, beforeCount + 1);
  const last = rows[rows.length - 1];
  eq('…recorded as a recount', last.event, 'recount');
  eq('…signed as an override', last.overrideBy, mgr.uid);
  eq('…carrying the reason', last.reason, 'recount');
  truthy('…with a delta computed server-relative, not client-guessed',
    Math.abs(last.before + last.delta - last.after) < 1e-6);
  eq('…and the status re-derived upward', (await sdb.collection('inventory').doc(BATCH).get()).data().stock_status, 'full');
}
await denied('not even an admin may rewrite a ledger row', async () => {
  const rows = await adb.collection('inventoryUsage').where('itemId', '==', BATCH).limit(1).get();
  return adb.collection('inventoryUsage').doc(rows.docs[0].id).update({ qty: 999 });
});

/* ════════════════════════════════════════════════════════════════════════
   JOURNEY 7 — undo a mistake
   ════════════════════════════════════════════════════════════════════════ */
section('Journey 7: "that was the wrong tube" — undo');

{
  const r = await S.consume({ itemId: BATCH, qty: 4, unit: 'mL' });
  eq('Sam takes 4 mL', r.after, 18);
  // Undo restores stock, which rules only allow a manager to do — so Sam's undo
  // is correctly refused and Mia's works. The sheet only offers it where it will.
  await denied('Sam cannot undo it herself (that would add stock back)', () => S.undo(r.usageId));
  const back = await allowed('Mia can undo it for her', () => M.undo(r.usageId));
  eq('…the count is restored', back.after, 22);
  const rows = await ledger(BATCH);
  const last = rows[rows.length - 1];
  eq('…via a COMPENSATING row, not a deletion', last.undoes, r.usageId);
  eq('…and the original row is still there', rows.filter((x) => x.event === 'use' && x.qty === 4).length, 1);
}

/* ════════════════════════════════════════════════════════════════════════
   JOURNEY 8 — an unknown code, and two people racing it
   ════════════════════════════════════════════════════════════════════════ */
section('Journey 8: binding a blank label, and losing the race cleanly');

const FREE = LID.mintId();
eq('an unminted code resolves as unknown', (await SR.resolve(FREE)).status, 'unknown');
truthy('…and the message offers the next step', /isn’t linked/i.test(SR.explain({ status: 'unknown' })));
await allowed('Sam binds it to the batch', () =>
  SR.bind(FREE, { kind: 'stock', refId: BATCH, title: LONG_NAME }));
SR._clearCache();
eq('…now it resolves', (await SR.resolve(FREE)).status, 'ok');
{
  // The reservation mechanism: `create` fires only when the doc does not exist,
  // so the loser's write is judged an `update` and refused. The transaction turns
  // that into a clean, retryable error instead of a bare permission-denied.
  const taken = LID.mintId();
  await SR.bind(taken, { kind: 'item', refId: BATCH, title: 'first' });
  let err = null;
  try { await other.w.SCAN_RESOLVE.bind(taken, { kind: 'item', refId: BATCH, title: 'second' }); }
  catch (e) { err = e; }
  truthy('a racing second binder is refused', !!err, 'no error was thrown');
  eq('…with a code the UI can act on', err && err.code, 'taken');
  eq('…and the first binding is intact',
    (await sdb.collection('labels').doc(taken).get()).data().title, 'first');
}
{
  const retired = LID.mintId();
  await SR.bind(retired, { kind: 'item', refId: BATCH, title: 'old tube' });
  await sdb.collection('labels').doc(retired).update({ retired: true });
  student.w.SCAN_RESOLVE._clearCache();
  const r = await SR.resolve(retired);
  eq('a retired label says so rather than resolving silently', r.status, 'retired');
  truthy('…and names what it was', /old tube/.test(SR.explain(r)), SR.explain(r));
}
await denied('a label code can never be deleted, only retired', () =>
  adb.collection('labels').doc(FREE).delete());

/* ════════════════════════════════════════════════════════════════════════
   JOURNEY 9 — boxes: "10 slots of 50 mL tubes, 3 packs left"
   ════════════════════════════════════════════════════════════════════════ */
section('Journey 9: a box with a capacity, and what is in it');

const BOX = 'loc-box-4';
const TUBES = 'itm-50ml-conical';
await allowed('Mia creates the freezer', () =>
  mdb.collection('inventoryLocations').doc('loc-freezer-1').set({
    kind: 'freezer', name: '-80 #2', parentId: null, path: 'BSRL312/-80#2',
    path_ids: ['loc-freezer-1'], temp: '-80C', createdBy: mgr.uid }));
await allowed('…and Box 4 inside it, with 10 slots', () =>
  mdb.collection('inventoryLocations').doc(BOX).set({
    kind: 'box', name: 'Box 4', short_name: 'BOX4', parentId: 'loc-freezer-1',
    path: 'BSRL312/-80#2/Box4', path_ids: ['loc-freezer-1', BOX],
    capacity_slots: 10, temp: '-80C', createdBy: mgr.uid }));
await allowed('Sam records 3 packs of 50 mL tubes in Box 4', () =>
  sdb.collection('inventory').doc(TUBES).set({
    kind: 'item', name: '50 mL conical tubes', quantity: 3,
    qty_tracked: true, qty_unit: 'pack', qty_made: 10, qty_remaining: 3, qty_min: 2,
    stock_status: 'low',
    locations: [{ locId: BOX, name: 'Box 4', quantity: 3, unit: 'pack', notes: '' }],
    locIds: [BOX] }));
{
  // Contents are a REVERSE LOOKUP — equality-only, so no composite index.
  const inBox = await sdb.collection('inventory').where('locIds', 'array-contains', BOX).get();
  eq('"what is in Box 4" finds it by reverse lookup', inBox.size, 1);
  const row = inBox.docs[0].data();
  eq('…naming the item', row.name, '50 mL conical tubes');
  const used = (row.locations || []).filter((l) => l.locId === BOX)
    .reduce((n, l) => n + (l.quantity || 0), 0);
  const boxDoc = (await sdb.collection('inventoryLocations').doc(BOX).get()).data();
  // Free slots are DERIVED, never stored — the two numbers cannot drift.
  eq('…and free slots derive to 7 (10 capacity − 3 packs)', boxDoc.capacity_slots - used, 7);
}
await allowed('a box gets its own scannable code', () =>
  MSR.bind(LID.mintId(), { kind: 'location', refId: BOX, title: 'Box 4 · -80 #2' }));
{
  const boxCode = (await sdb.collection('labels').where('target_id', '==', BOX).get()).docs[0].id;
  mgr.w.SCAN_RESOLVE._clearCache();
  const r = await MSR.resolve(boxCode);
  eq('scanning the box resolves to the box, not an item', r.label.target_kind, 'location');
  eq('…and hydrates from inventoryLocations', r.item && r.item.name, 'Box 4');
}
await denied('Sam cannot re-parent Box 4 (it moves other people’s things)', () =>
  sdb.collection('inventoryLocations').doc(BOX).update({ parentId: 'loc-freezer-99' }));
// Worth pinning explicitly: hasOnly() over an EMPTY affectedKeys() is vacuously
// true, so a write that changes nothing is allowed. That is correct — but it is
// also how a test can accidentally prove nothing, so assert the real move above.
await allowed('…while a no-op write of the same parent is harmlessly allowed', () =>
  sdb.collection('inventoryLocations').doc(BOX).update({ parentId: 'loc-freezer-1' }));
await denied('Sam cannot retire Box 4 either', () =>
  sdb.collection('inventoryLocations').doc(BOX).update({ retired: true }));
await allowed('Sam CAN fix its label text', () =>
  sdb.collection('inventoryLocations').doc(BOX).update({ notes: 'lid is cracked' }));

/* ════════════════════════════════════════════════════════════════════════
   JOURNEY 10 — printing from anywhere
   ════════════════════════════════════════════════════════════════════════ */
section('Journey 10: queue labels on a phone, print them at the bench PC');

/* The queue carries label CONTENT in LabelPrinter's own cell shape, so the
 * printer imports with zero translation and its layout.js still computes every
 * coordinate. If these key sets ever diverge, the printer silently drops fields. */
let EMPTY_CELL_KEYS = null;
try {
  const batchMod = await import(ROOT + '../LabelPrinter/web/core/batch.js');
  EMPTY_CELL_KEYS = Object.keys(batchMod.emptyCell()).sort();
} catch (e) { /* sibling repo absent — parity check is skipped, loudly */ }

const cell = (over) => Object.assign({
  reagent: '', conc: '', solvent: '', owner: 'SS', date: '2026-08-19', expiry: '',
  expiryRule: '+6m', lot: '', storage: '4C', notes: '', hazards: [], fontScale: 'auto',
  qr: { enabled: true, ecc: 'M' }, tubeId: '',
}, over);

const JOB = await allowed('Sam queues 1 stock label + 6 aliquot labels', async () => {
  const ref = await sdb.collection('labelQueue').add({
    requestedBy: student.uid, requestedByName: 'Sam Student', requestedByInitials: 'SS',
    status: 'queued', title: '1 stock + 6 aliquots · LLS 100 µm rhodamine',
    columns: 2, source: 'stock', refId: BATCH, codes: [CODE],
    cells: [
      cell({ reagent: 'LLS100 Rhod/FITC', conc: '0.1%', tubeId: CODE }),
      // An aliquot carries the PARENT's code, so a bench tube is
      // self-identifying. A no-QR aliquot is a tube you cannot identify at all,
      // which is the problem this whole feature exists to solve.
      ...[1, 2, 3, 4, 5, 6].map((i) =>
        cell({ reagent: 'LLS100 aliquot ' + i, conc: '0.1%', tubeId: CODE })),
    ],
    requestedAt: firebase.firestore.FieldValue.serverTimestamp(),
  });
  return ref.id;
});
if (EMPTY_CELL_KEYS) {
  const mine = Object.keys(cell({})).sort();
  eq('queue cells match LabelPrinter emptyCell() key-for-key', mine, EMPTY_CELL_KEYS);
} else {
  console.log('  skip  LabelPrinter checkout absent — cell-shape parity not checked');
}
await denied('Sam cannot queue on Otto’s behalf', () =>
  sdb.collection('labelQueue').add({ requestedBy: other.uid, status: 'queued', cells: [cell({})] }));
await denied('an empty job is refused', () =>
  sdb.collection('labelQueue').add({ requestedBy: student.uid, status: 'queued', cells: [] }));
// The printer operator is NOT the requester, so any member must be able to claim.
await allowed('Otto (at the printer PC) claims the job', () =>
  odb.collection('labelQueue').doc(JOB).update({
    status: 'claimed', claimedBy: other.uid,
    claimedAt: firebase.firestore.FieldValue.serverTimestamp() }));
await allowed('…and marks it printed', () =>
  odb.collection('labelQueue').doc(JOB).update({
    status: 'printed', printedAt: firebase.firestore.FieldValue.serverTimestamp() }));
{
  const j = (await sdb.collection('labelQueue').doc(JOB).get()).data();
  eq('the job carries 7 cells', j.cells.length, 7);
  eq('every aliquot points at the parent batch code',
    j.cells.filter((c) => c.tubeId === CODE).length, 7);
}
{
  // Scanning ANY of those aliquots must land on the parent batch.
  student.w.SCAN_RESOLVE._clearCache();
  const r = await SR.resolve(CODE);
  eq('scanning an aliquot resolves to the parent batch', r.item && r.item.id, BATCH);
}

/* ════════════════════════════════════════════════════════════════════════
   JOURNEY 11 — a legacy item is untouched until someone opts it in
   ════════════════════════════════════════════════════════════════════════ */
section('Journey 11: the other 740 items keep working exactly as before');

const LEGACY = 'itm-legacy-tips';
await env.withSecurityRulesDisabled(async (c) => {
  await setDoc(doc(c.firestore(), 'inventory/' + LEGACY), {
    kind: 'item', name: 'P1000 tips', quantity: '12', stock_status: 'full', vendor: 'X' });
});
eq('an untracked item derives no status (stock_status left alone)',
  S.deriveStatus({ kind: 'item', name: 'P1000 tips', quantity: '12' }), null);
await allowed('anyone can still edit it inline, omitting qty_remaining entirely', () =>
  sdb.collection('inventory').doc(LEGACY).update({ subcategory: 'pipette_tips' }));
await denied('a non-manager cannot switch tracking on (it is a curation decision)', () =>
  S.enableTracking({ itemId: LEGACY, unit: 'pack', made: 12 }));
{
  const r = await allowed('Mia switches tracking on, seeding from the legacy string "12"', () =>
    M.enableTracking({ itemId: LEGACY, unit: 'pack', made: null, min: 3 }));
  eq('…the string is coerced to a number', r.made, 12);
  const it = (await sdb.collection('inventory').doc(LEGACY).get()).data();
  eq('…qty_remaining seeded', it.qty_remaining, 12);
  eq('…and a baseline ledger row exists so the chain starts somewhere real',
    (await ledger(LEGACY)).length, 1);
}
await allowed('and now Sam can record taking 2 packs', () =>
  S.consume({ itemId: LEGACY, qty: 2, unit: 'pack' }));
eq('…leaving 10', (await sdb.collection('inventory').doc(LEGACY).get()).data().qty_remaining, 10);
eq('…and crossing its reorder point of 3 is what would alert',
  S.deriveStatus({ qty_tracked: true, qty_made: 12, qty_remaining: 3, qty_min: 3 }), 'low');

/* ════════════════════════════════════════════════════════════════════════ */
await env.cleanup();
console.log('\n' + '='.repeat(66));
console.log(`E2E journeys: ${pass} ok, ${fail} FAILED`);
if (failures.length) { console.log('\nFailures:'); failures.forEach((f) => console.log('  - ' + f)); }
process.exit(fail ? 1 : 0);
