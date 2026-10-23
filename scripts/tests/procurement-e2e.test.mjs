/* procurement-e2e.test.mjs — V3.813 end-to-end journeys
 * ============================================================================
 * The REAL state machine (rm/js/procurement-core.js, the bytes the page
 * ships) driving the REAL firestore.rules as REAL signed-in users, through
 * the whole loop: submit → question → answer → approve → edit-after-approval
 * → re-approve → batch order on one PO → receive → put away (new item AND
 * restock of a tracked item by a member and by a manager) → notes → delete.
 * Plus the writes that must be refused on the way.
 *
 * The writer below is a verbatim mirror of procurement.js's createTicket /
 * writeTicket (arrayUnion the appends, serverTimestamp the stamps). If the
 * page and this file ever disagree about how a patch is written, the rules
 * test can pass while the page fails — keep them identical.
 *
 * Run:
 *   JAVA_HOME=/opt/homebrew/opt/openjdk@21 PATH=$JAVA_HOME/bin:$PATH \
 *   cd scripts/tests && AUTH_EMU_PORT=9299 firebase emulators:exec --config firebase.proc.json \
 *     --only firestore,auth --project demo-mcgheelab-proc-e2e "node procurement-e2e.test.mjs"
 * ============================================================================ */
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { doc, setDoc, getDoc } from 'firebase/firestore';
import firebase from 'firebase/compat/app';
import 'firebase/compat/auth';
import 'firebase/compat/firestore';

const require = createRequire(import.meta.url);
const C = require('../../rm/js/procurement-core.js');
const PID = 'demo-mcgheelab-proc-e2e';
const ROOT = new URL('../../', import.meta.url).pathname;

let pass = 0, fail = 0; const failures = [];
const ok = (n) => { console.log('  ok    ' + n); pass++; };
const bad = (n, d) => { console.log('  FAIL  ' + n + (d ? '   → ' + d : '')); failures.push(n); fail++; };
const eq = (n, g, w) => (JSON.stringify(g) === JSON.stringify(w) ? ok(n) : bad(n, `got ${JSON.stringify(g)}, want ${JSON.stringify(w)}`));
const truthy = (n, v, d) => (v ? ok(n) : bad(n, d));
async function denied(n, fn) { try { await fn(); bad(n, 'the write SUCCEEDED — that is a hole'); } catch (e) { const m = (e && e.message) || '', c = (e && e.code) || ''; (/permission|PERMISSION|insufficient|core:/i.test(m) || /permission-denied/i.test(c)) ? ok(n + (/core:/.test(m) ? ' (refused by the core)' : '')) : bad(n, 'failed for the wrong reason: code=' + c + ' message=' + m + ' ' + (e && e.name)); } }
async function allowed(n, fn) { try { const r = await fn(); ok(n); return r; } catch (e) { bad(n, 'denied, but a real user needs this: ' + e.message); return null; } }
const section = (t) => console.log('\n── ' + t + ' ──');

const FSPORT = +(process.env.FS_EMU_PORT || 8199);
const env = await initializeTestEnvironment({
  projectId: PID,
  firestore: { rules: readFileSync(ROOT + 'firestore.rules', 'utf8'), host: '127.0.0.1', port: FSPORT },
});
const CFG = { apiKey: 'fake-api-key', projectId: PID, authDomain: 'localhost' };
const AUTH = 'http://127.0.0.1:' + (process.env.AUTH_EMU_PORT || '9099');   // firebase.proc.json uses 9299

/* ONE NAMED FIREBASE APP PER ACTOR (see inventory-e2e.test.mjs for why). */
async function actor(email, profile, caps) {
  const app = firebase.initializeApp(CFG, email);
  app.auth().useEmulator(AUTH, { disableWarnings: true });
  app.firestore().useEmulator('127.0.0.1', FSPORT);
  const cred = await app.auth().createUserWithEmailAndPassword(email, 'password123');
  const uid = cred.user.uid;
  await env.withSecurityRulesDisabled(async (c) => {
    await setDoc(doc(c.firestore(), 'users/' + uid), Object.assign({ role: 'editor' }, profile));
    if (caps) await setDoc(doc(c.firestore(), 'userPermissions/' + uid), { caps });
  });
  const core = C.actorFrom({ uid, email, displayName: profile.name }, Object.assign({ role: 'editor' }, profile), (c) => !!(caps && caps.includes(c)));
  return { uid, email, db: app.firestore(), core, name: profile.name };
}
const stu = await actor('student@test.lab', { name: 'Sam Student' });
const oth = await actor('other@test.lab',   { name: 'Otto Other' });
const app = await actor('approver@test.lab', { name: 'Ava Approver' }, ['procurement:approve']);
const buy = await actor('buyer@test.lab',   { name: 'Bo Buyer', role: 'contributor' }, ['procurement:order']);
const mgr = await actor('mgr@test.lab',     { name: 'Mia Manager' }, ['inventory:manage']);
const adm = await actor('admin@test.lab',   { name: 'The PI', role: 'admin' });

/* ── the writer: verbatim mirror of procurement.js ─────────────────────── */
const FV = () => firebase.firestore.FieldValue;
async function create(a, values, extra) {
  const r = C.buildCreate(values, a.core, Date.now(), FV().serverTimestamp(), extra);
  if (r.error) throw new Error('core: ' + r.error);
  const ref = await a.db.collection('procurementTickets').add(r.data);
  return ref.id;
}
async function readAs(a, id) { const s = await a.db.collection('procurementTickets').doc(id).get(); return s.exists ? Object.assign({ id }, s.data()) : null; }
async function act(a, id, action, values, batch) {
  const t = await readAs(a, id);
  const stamp = FV().serverTimestamp();
  const r = C.buildPatch(action, t, values || {}, a.core, Date.now(), stamp);
  if (r.error) throw new Error('core: ' + r.error);
  if (r.deleteDoc) { await a.db.collection('procurementTickets').doc(id).delete(); return r; }
  const patch = Object.assign({}, r.patch);
  if (r.appends.history.length) patch.history = FV().arrayUnion(...r.appends.history);
  if (r.appends.notes.length) patch.notes = FV().arrayUnion(...r.appends.notes);
  if (r.appends.watcherUids.length) patch.watcherUids = FV().arrayUnion(...r.appends.watcherUids);
  const ref = a.db.collection('procurementTickets').doc(id);
  if (batch) batch.update(ref, patch); else await ref.update(patch);
  return r;
}
/* a raw write that bypasses the core's own gate — proves the RULES refuse it */
async function raw(a, id, patch) { await a.db.collection('procurementTickets').doc(id).update(patch); }

section('submit');
const peg = await allowed('student submits a request', () => create(stu, { itemDescription: 'PEG 6000, 100 g', vendor: 'Sigma-Aldrich', quantity: 2, unitCost: 50, reason: 'gels', category: 'reagent', urgency: 'urgent', projectId: 'onr', project: 'ONR', fundingAccount: '3062920', fundingLabel: 'ONR · 3062920', purchaseType: 'one_time' }));
await denied('core refuses a request with no project', () => create(stu, { itemDescription: 'x', reason: 'y', purchaseType: 'one_time' }));
await denied('core refuses a request that does not say one-time or recurring (V3.814)', () => create(stu, { itemDescription: 'x', reason: 'y', project: 'P' }));
const tips = await allowed('student submits a second request, same vendor, project "Other" (no funding string yet), recurring with a price comparison', () => create(stu, { itemDescription: 'Pipette tips 200 µL', vendor: 'sigma aldrich', quantity: 1, unitCost: 80, reason: 'daily', projectId: '__other', project: 'Lab general', purchaseType: 'recurring', recurrence: 'monthly', comparisons: [{ vendor: 'Fisher', unitPrice: '$85.00', url: 'https://fisher.com/tips' }, { vendor: 'Sigma Aldrich', unitPrice: 80 }] }));
{
  const t = await readAs(oth, tips);
  eq('purchase type, recurrence and the comparison are stored; the Sigma row is marked chosen', [t.purchaseType, t.recurrence, t.comparisons.length, t.comparisons[0].unitPrice, t.comparisons[1].chosen, t.repeatOf], ['recurring', 'monthly', 2, 85, true, null]);
}
{
  const t = await readAs(oth, peg);
  eq('status requested, estimate = 100, history 1, watcher = requester', [t.status, t.estimatedCost, t.history.length, t.watcherUids, t.lastActorUid], ['requested', 100, 1, [stu.uid], stu.uid]);
  truthy('createdAt is a server timestamp', t.createdAt && typeof t.createdAt.toMillis === 'function');
}
await denied('student submits in someone else\'s name', () => stu.db.collection('procurementTickets').add(Object.assign(C.buildCreate({ itemDescription: 'x', reason: 'y', project: 'P', purchaseType: 'one_time' }, oth.core, Date.now(), FV().serverTimestamp()).data)));
await denied('core refuses an empty request', () => create(stu, { itemDescription: '', reason: 'y', purchaseType: 'one_time' }));

section('question ⇄ answer');
await denied('student approves own request', () => act(stu, peg, 'approve', {}));
await denied('student approves own request with a raw write', () => raw(stu, peg, { status: 'approved' }));
await denied('bystander asks a question', () => act(oth, peg, 'ask', { note: 'why?' }));
await allowed('approver asks a question', () => act(app, peg, 'ask', { note: 'Which molecular weight exactly?' }));
{
  const t = await readAs(stu, peg);
  eq('ticket is needs_info with the question stored and in the thread', [t.status, t.question, t.notes.length, t.notes[0].kind, t.lastActorUid], ['needs_info', 'Which molecular weight exactly?', 1, 'question', app.uid]);
}
await denied('bystander answers for the student', () => act(oth, peg, 'answer', { note: '6000' }));
await allowed('student answers', () => act(stu, peg, 'answer', { note: '6000 Da, the Sigma 81260' }));
{
  const t = await readAs(stu, peg);
  eq('back to requested, question cleared, two notes, approver now watches', [t.status, t.question, t.notes.length, t.watcherUids.includes(app.uid)], ['requested', null, 2, true]);
}

section('approve, edit after approval, re-approve');
await allowed('approver approves with a note', () => act(app, peg, 'approve', { note: 'Fine — use the ONR account.' }));
await denied('approver cannot approve the "Other" request without assigning a project', () => act(app, tips, 'approve', {}));
await allowed('approver approves the second request, assigning the project', () => act(app, tips, 'approve', { projectId: 'startup', project: 'McGhee Startup', fundingAccount: '1101935', fundingLabel: 'McGhee Startup · 1101935' }));
{
  const t = await readAs(stu, tips);
  eq('the ticket now carries the project + funding string the purchaser charges', [t.projectId, t.project, t.fundingAccount], ['startup', 'McGhee Startup', '1101935']);
}
{
  const t = await readAs(stu, peg);
  eq('approved stamps', [t.status, t.approvedBy, t.piNotes, typeof t.approvedAt.toMillis], ['approved', app.uid, 'Fine — use the ONR account.', 'function']);
}
await allowed('student edits the approved ticket (goes back for re-approval)', async () => act(stu, peg, 'edit', Object.assign(C.cleanRequest(await readAs(stu, peg)), { quantity: 3 })));
{
  const t = await readAs(stu, peg);
  eq('edit after approval: requested again, approval cleared, qty 3, estimate recomputed', [t.status, t.approvedBy, t.quantity, t.estimatedCost], ['requested', null, 3, 150]);
  truthy('history says what changed and that it needs re-approval', /quantity.*re-approval/.test(t.history[t.history.length - 1].note), t.history[t.history.length - 1].note);
}
await raw(adm, peg, { status: 'approved' });   // admin sets the scene for the next negative
await denied('student quietly edits the cost and KEEPS the approved status (raw write)', () => raw(stu, peg, { unitCost: 1 }));
await raw(adm, peg, { status: 'requested' });  // and restores it
await allowed('approver re-approves', () => act(app, peg, 'approve', {}));

section('order — one PO for two tickets');
await denied('approver (no order cap) marks ordered', () => act(app, peg, 'order', { purchaseMethod: 'buyways', poNumber: 'PO-1' }));
await denied('student marks own ordered', () => act(stu, peg, 'order', { purchaseMethod: 'buyways' }));
await denied('purchaser orders without saying how it was bought', () => act(buy, peg, 'order', { purchaseMethod: '' }));
{
  const t = await readAs(buy, peg);
  const cands = C.batchCandidates([t, await readAs(buy, tips)], t);
  eq('the second ticket is a batch candidate (vendor normalized)', cands.map((c) => c.id), [tips]);
  const groupId = C.genId();
  const batch = buy.db.batch();
  await act(buy, peg, 'order', { purchaseMethod: 'buyways', poNumber: 'PO-2026-014', orderDate: '2026-10-19', expectedDelivery: '2026-10-26', poUrl: 'https://storage/po.pdf', poStoragePath: 'procurement/x/po.pdf', orderGroupId: groupId }, batch);
  await act(buy, tips, 'order', { purchaseMethod: 'buyways', poNumber: 'PO-2026-014', orderDate: '2026-10-19', expectedDelivery: '2026-10-26', poUrl: 'https://storage/po.pdf', poStoragePath: 'procurement/x/po.pdf', orderGroupId: groupId }, batch);
  await allowed('purchaser commits both in ONE batch', () => batch.commit());
  const a = await readAs(stu, peg), b = await readAs(stu, tips);
  eq('both ordered on the same PO + group', [a.status, b.status, a.poNumber, b.poNumber, a.orderGroupId === b.orderGroupId && !!a.orderGroupId, a.orderedBy, a.poUrl], ['ordered', 'ordered', 'PO-2026-014', 'PO-2026-014', true, buy.uid, 'https://storage/po.pdf']);
}
await allowed('purchaser edits the ETA', () => act(buy, peg, 'edit_order', { purchaseMethod: 'buyways', poNumber: 'PO-2026-014', orderDate: '2026-10-19', expectedDelivery: '2026-10-28' }));

section('V3.814 — change the funding after the order was placed');
const OPTS = C.fundedProjectOptions([{ id: 'onr', name: 'ONR', account_number: '3062920', status: 'active' }, { id: 'startup', name: 'McGhee Startup', account_number: '1101935', status: 'active' }], []);
await denied('purchaser changes the funding on the ordered ticket', () => act(buy, peg, 'reassign', C.applyProject({}, OPTS, 'startup')));
await denied('student changes the funding on their own ordered ticket', () => act(stu, peg, 'reassign', C.applyProject({}, OPTS, 'startup')));
await denied('bystander changes the funding (raw write with the right keys)', () => raw(oth, peg, { fundingAccount: '1101935', fundingLabel: 'x', lastActorUid: oth.uid }));
await denied('core refuses reassigning to the SAME project', () => act(app, peg, 'reassign', C.applyProject({}, OPTS, 'onr')));
await allowed('approver moves the ordered ticket to the startup account with a reason', () => act(app, peg, 'reassign', Object.assign(C.applyProject({}, OPTS, 'startup'), { note: 'ONR is overspent this quarter' })));
{
  const t = await readAs(stu, peg);
  eq('still ordered; new project + funding string; who/from stamped; history + funding note appended', [t.status, t.projectId, t.fundingAccount, t.fundingLabel, t.fundingChangedBy, t.fundingChangedFrom, t.history[t.history.length - 1].action, t.notes[t.notes.length - 1].kind, t.poNumber], ['ordered', 'startup', '1101935', 'McGhee Startup · 1101935', app.uid, 'ONR · 3062920', 'reassign', 'funding', 'PO-2026-014']);
  truthy('the history line says from → to and why', /Now charged to McGhee Startup · 1101935 \(was ONR · 3062920\) — ONR is overspent/.test(t.history[t.history.length - 1].note), t.history[t.history.length - 1].note);
  // the function's plan for this very write (same bytes the trigger runs)
  const N = require('../../functions/procurement-notify.js')._internal;
  const before = Object.assign({}, t, { history: t.history.slice(0, -1), notes: t.notes.slice(0, -1), fundingLabel: 'ONR · 3062920' });
  const p = N.plan(before, t);
  eq('the trigger would tell the requester AND the purchasers (ordered)', p.map((x) => x.audience).sort(), ['purchasers', 'requester']);
  truthy('…with the follow-up text', /Ava Approver moved it to McGhee Startup · 1101935 \(was ONR · 3062920\) — ONR is overspent this quarter\./.test(p[0].body), p[0].body);
}
await allowed('admin moves it back (admins are approvers)', () => act(adm, peg, 'reassign', C.applyProject({}, OPTS, 'onr')));
{ const t = await readAs(stu, peg); eq('back on ONR, from = startup', [t.fundingAccount, t.fundingChangedFrom], ['3062920', 'McGhee Startup · 1101935']); }
await denied('student withdraws after it was ordered', () => act(stu, peg, 'cancel', {}));
await allowed('bystander flags a problem', () => act(oth, peg, 'flag', { note: 'Backordered until November' }));
await denied('bystander clears the flag', () => act(oth, peg, 'clear_issue', {}));
await allowed('purchaser clears the flag', () => act(buy, peg, 'clear_issue', { note: 'Shipped after all' }));

section('receive and put away a NEW item');
await denied('bystander puts away something that has not arrived', () => act(oth, peg, 'place', { location: 'Shelf', mode: 'new', inventoryItemId: 'x' }));
await allowed('bystander marks received with actual cost', () => act(oth, peg, 'receive', { quantityReceived: 3, actualCost: 147.6, note: 'all three bottles' }));
{
  const t = await readAs(stu, peg);
  eq('received stamps', [t.status, t.receivedBy, t.quantityReceived, t.actualCost, t.receivedNote], ['received', oth.uid, 3, 147.6, 'all three bottles']);
  const stamp = FV().serverTimestamp();
  const data = C.newInventoryItem(t, { location: 'Cold room shelf 3', category: 'research_reagents', notes: 'lot 42' }, stu.core, stamp);
  const ref = await allowed('student creates the inventory item', () => stu.db.collection('inventory').add(data));
  await allowed('student puts away → placed', () => act(stu, peg, 'place', { location: 'Cold room shelf 3', mode: 'new', inventoryItemId: ref.id }));
  const p = await readAs(stu, peg);
  eq('placed stamps + back-link', [p.status, p.location, p.inventoryItemId === ref.id, p.placementMode, p.placedBy], ['placed', 'Cold room shelf 3', true, 'new', stu.uid]);
  const inv = (await stu.db.collection('inventory').doc(ref.id).get()).data();
  eq('inventory doc: item kind, qty 3, unit price derived from actual cost, location, ticket link, reorder info', [inv.kind, inv.quantity, inv.unit_price, inv.locations[0].name, inv.procurementTicketId, inv.reorder.vendor, inv.category, inv.account_number], ['item', 3, 49.2, 'Cold room shelf 3', peg, 'Sigma-Aldrich', 'research_reagents', '3062920']);
  eq('timeline of the whole journey', p.history.map((h) => h.action), ['submit', 'ask', 'answer', 'approve', 'edit', 'approve', 'order', 'edit_order', 'reassign', 'reassign', 'flag', 'clear_issue', 'receive', 'place']);
  eq('everyone who acted is a watcher', [stu.uid, app.uid, buy.uid, oth.uid].every((u) => p.watcherUids.includes(u)), true);
}
await denied('bystander reopens a placed ticket', () => raw(oth, peg, { status: 'received' }));
await allowed('bystander still adds a note to a placed ticket', () => act(oth, peg, 'note', { note: 'Opened one bottle.' }));

section('restock an EXISTING tracked item');
let invTracked;
await env.withSecurityRulesDisabled(async (c) => {
  await setDoc(doc(c.firestore(), 'inventory/tips-tracked'), { kind: 'item', name: 'Pipette tips 200 µL', vendor: 'Sigma', quantity: 10, qty_tracked: true, qty_unit: 'ea', qty_made: 10, qty_remaining: 4, qty_min: 5, stock_status: 'low', locations: [{ name: 'Bench 4', quantity: 10, notes: '' }] });
  invTracked = 'tips-tracked';
});
await allowed('bystander marks the tips received', () => act(oth, tips, 'receive', { quantityReceived: 1, actualCost: 80 }));
{
  const t = await readAs(oth, tips);
  const item = Object.assign({ id: invTracked }, (await oth.db.collection('inventory').doc(invTracked).get()).data());
  const stamp = FV().serverTimestamp();
  const plan = C.restockPlan(item, t, { location: 'bench 4', quantity: 1, unitPrice: 80 }, oth.core, stamp);
  eq('member plan: location merged case-insensitively, quantity bumped, ledger untouched', [plan.patch.quantity, plan.patch.locations.length, plan.patch.locations[0].quantity, plan.patch.qty_remaining, plan.usage], [11, 1, 11, undefined, null]);
  await allowed('member restock write passes the V3.646 quantity rules', () => oth.db.collection('inventory').doc(invTracked).update(plan.patch));
  await allowed('member puts away → placed (restock)', () => act(oth, tips, 'place', { location: 'bench 4', mode: 'restock', inventoryItemId: invTracked }));
  const p = await readAs(oth, tips);
  eq('restock placement recorded', [p.status, p.placementMode, p.inventoryItemId], ['placed', 'restock', invTracked]);
  // a member must NOT be able to raise the ledger even via the plan a manager would get
  const mgrPlan = C.restockPlan(item, t, { location: 'bench 4', quantity: 1 }, mgr.core, stamp);
  await denied('member writes the MANAGER plan (raises qty_remaining)', () => oth.db.collection('inventory').doc(invTracked).update(mgrPlan.patch));
  await denied('member writes an inventoryUsage add row', () => oth.db.collection('inventoryUsage').add(Object.assign({}, mgrPlan.usage, { userUid: oth.uid })));
  // the manager's turn (a second delivery of the same item)
  const item2 = Object.assign({ id: invTracked }, (await mgr.db.collection('inventory').doc(invTracked).get()).data());
  const mp = C.restockPlan(item2, t, { location: 'Freezer B', quantity: 2, unitPrice: 80 }, mgr.core, stamp);
  eq('manager plan raises the ledger and adds a location (qty_made 10 → 12: the member restock never touched it)', [mp.patch.qty_remaining, mp.patch.qty_made, mp.usage.event, mp.usage.before, mp.usage.after, mp.patch.locations.length, mp.ledgerRaised], [6, 12, 'add', 4, 6, 2, true]);
  await allowed('manager restock write', () => mgr.db.collection('inventory').doc(invTracked).update(mp.patch));
  await allowed('manager ledger row', () => mgr.db.collection('inventoryUsage').add(mp.usage));
  const final = (await mgr.db.collection('inventory').doc(invTracked).get()).data();
  eq('item after both restocks', [final.quantity, final.qty_remaining, final.locations.map((l) => l.name + ':' + l.quantity)], [13, 6, ['Bench 4:11', 'Freezer B:2']]);
  eq('V3.814: the restocked item learned the comparison + recurring from the ticket', [final.reorder.recurring, (final.reorder.alternatives || []).map((a) => a.vendor)], [true, ['Fisher', 'Sigma Aldrich']]);
  // Request again from the placed tips ticket → a new recurring ticket that restocks the same item
  const t2 = await readAs(stu, tips);
  const pre = C.prefillFromTicket(t2);
  const rep = await allowed('student files the tips again from the placed ticket (Request again)', () => create(stu, pre, { inventoryItemId: pre.inventoryItemId, source: 'repeat', repeatOf: pre.repeatOf }));
  const r2 = await readAs(stu, rep);
  eq('the repeat ticket: requested, recurring, same comparison, restocks INV, points at the original', [r2.status, r2.purchaseType, r2.comparisons.length, r2.inventoryItemId, r2.repeatOf, r2.source, r2.fundingAccount], ['requested', 'recurring', 2, invTracked, tips, 'repeat', '1101935']);
}

section('deny, withdraw, reopen, delete');
const den = await create(stu, { itemDescription: 'Gold-plated centrifuge', reason: 'because', unitCost: 90000, project: 'Dreams', projectId: '__other', purchaseType: 'one_time' });
await denied('approver denies with no reason (core)', () => act(app, den, 'deny', { note: '' }));
await allowed('approver denies with a reason', () => act(app, den, 'deny', { note: 'Not this year.' }));
await denied('student reopens a denied ticket', () => act(stu, den, 'reopen', {}));
await allowed('approver reopens it', () => act(app, den, 'reopen', {}));
await allowed('student withdraws', () => act(stu, den, 'cancel', { note: 'found one in the hallway' }));
await denied('bystander reopens a withdrawn ticket', () => act(oth, den, 'reopen', {}));
await allowed('student reopens own withdrawn ticket', () => act(stu, den, 'reopen', {}));
{
  const t = await readAs(stu, den);
  eq('reopened cleanly', [t.status, t.deniedBy, t.cancelledBy, t.piNotes], ['requested', null, null, '']);
}
await denied('student deletes', () => act(stu, den, 'delete', {}));
await denied('purchaser deletes (raw)', () => buy.db.collection('procurementTickets').doc(den).delete());
await allowed('admin deletes', () => act(adm, den, 'delete', {}));
eq('ticket gone', await readAs(adm, den), null);

section('legacy V3.44 ticket (no history / notes / watchers)');
await env.withSecurityRulesDisabled(async (c) => {
  await setDoc(doc(c.firestore(), 'procurementTickets/legacy1'), { requestedBy: stu.uid, requesterName: 'Sam', itemDescription: 'Old gloves', reason: 'hands', status: 'requested', estimatedCost: 20, createdAt: new Date('2026-09-01') });
});
await denied('a V3.44 ticket with only a project TAG cannot be approved without a funding string', () => act(adm, 'legacy1', 'approve', { note: 'ok' }));
await allowed('admin approves a legacy ticket, assigning the project (arrayUnion creates the arrays)', () => act(adm, 'legacy1', 'approve', { note: 'ok', projectId: 'startup', project: 'McGhee Startup', fundingAccount: '1101935', fundingLabel: 'McGhee Startup · 1101935' }));
{
  const t = await readAs(stu, 'legacy1');
  eq('legacy ticket now carries history + watchers', [t.status, t.history.length, t.watcherUids, t.notes.length], ['approved', 1, [adm.uid], 1]);
  truthy('its timeline synthesizes the submit from createdAt', C.timelineOf(Object.assign({}, t, { history: [] })).map((h) => h.action).join() === 'submit,approve');
}

section('edit as the answer to a question');
const qed = await create(stu, { itemDescription: 'Syringe filters 0.22 µm', reason: 'sterile media', vendor: '', unitCost: 60, projectId: 'onr', project: 'ONR', fundingAccount: '3062920', purchaseType: 'one_time' });
await allowed('approver asks which brand', () => act(app, qed, 'ask', { note: 'Which brand — Millex or Corning?' }));
await allowed('student answers by EDITING the request (vendor filled in)', async () => act(stu, qed, 'edit', Object.assign(C.cleanRequest(await readAs(stu, qed)), { vendor: 'Millipore (Millex)' })));
{
  const t = await readAs(stu, qed);
  eq('edit-as-answer: requested again, question cleared, vendor saved, history says so', [t.status, t.question, t.vendor, /answers the open question/.test(t.history[t.history.length - 1].note)], ['requested', null, 'Millipore (Millex)', true]);
}
await denied('student spoofs lastActorUid on a note', () => raw(stu, qed, { lastActorUid: app.uid, notes: [] }));

section('guest');
const gstApp = firebase.initializeApp(CFG, 'guest@test.lab');
gstApp.auth().useEmulator(AUTH, { disableWarnings: true });
gstApp.firestore().useEmulator('127.0.0.1', FSPORT);
const gcred = await gstApp.auth().createUserWithEmailAndPassword('guest@test.lab', 'password123');
await env.withSecurityRulesDisabled(async (c) => { await setDoc(doc(c.firestore(), 'users/' + gcred.user.uid), { role: 'guest' }); });
await denied('guest reads a ticket', () => gstApp.firestore().collection('procurementTickets').doc(peg).get());
await denied('guest submits', () => gstApp.firestore().collection('procurementTickets').add(C.buildCreate({ itemDescription: 'x', reason: 'y', project: 'P', purchaseType: 'one_time' }, { uid: gcred.user.uid, name: 'G' }, Date.now(), FV().serverTimestamp()).data));

console.log(`\nE2E journeys: ${pass} ok, ${fail} failed`);
if (failures.length) console.log(failures.map((f) => '  FAIL ' + f).join('\n'));
await env.cleanup();
process.exit(fail ? 1 : 0);
