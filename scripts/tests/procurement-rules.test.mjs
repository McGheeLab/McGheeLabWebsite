/* Procurement v2 (V3.813) firestore.rules test — the transition table.
 *
 * V3.44's rule was `allow update: if isLabMember()`: a requester could approve
 * their own ticket. This file is the proof that each role can do exactly its
 * own moves and nothing else, that identity fields are frozen, and that the
 * notes-only path works for everyone without opening the status.
 *
 * Run (same harness as inventory-rules.test.mjs):
 *   JAVA_HOME=/opt/homebrew/opt/openjdk@21 PATH=$JAVA_HOME/bin:$PATH \
 *   cd scripts/tests && firebase emulators:exec --only firestore \
 *     --project demo-mcgheelab-proc "node procurement-rules.test.mjs"
 *
 * Marks: ok / HOLE (allowed, should deny) / BREAK (denied, a real user needs it)
 */
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { readFileSync } from 'node:fs';
import { doc, setDoc, getDoc, getDocs, collection, updateDoc, deleteDoc, addDoc, setLogLevel, serverTimestamp } from 'firebase/firestore';

setLogLevel('silent');
const RULES = process.env.RULES_FILE || new URL('../../firestore.rules', import.meta.url).pathname;   // RULES_FILE= a scratch deploy copy
const env = await initializeTestEnvironment({
  projectId: 'demo-mcgheelab-proc',
  firestore: { rules: readFileSync(RULES, 'utf8'), host: '127.0.0.1', port: +(process.env.FS_EMU_PORT || 8199) },
});

let ok = 0, holes = 0, breaks = 0;
async function mustAllow(name, fn) { try { await fn(); console.log('  ok    ' + name); ok++; } catch (e) { console.log('  BREAK ' + name + '   → ' + (e.code || e.message)); breaks++; } }
async function mustDeny(name, fn) { try { await fn(); console.log('  HOLE  ' + name); holes++; } catch (e) { console.log('  ok    ' + name); ok++; } }

const stu = env.authenticatedContext('stu').firestore();
const oth = env.authenticatedContext('oth').firestore();
const app = env.authenticatedContext('app').firestore();   // cap: approve
const buy = env.authenticatedContext('buy').firestore();   // cap: order
const adm = env.authenticatedContext('adm').firestore();
const gst = env.authenticatedContext('gst').firestore();

const T0 = new Date('2026-10-19T12:00:00Z');
function ticket(over) {
  return Object.assign({ requestedBy: 'stu', requesterName: 'Sam', itemDescription: 'PEG 6000', reason: 'gels', status: 'requested',
    quantity: 1, unitCost: 10, estimatedCost: 10, history: [], notes: [], watcherUids: ['stu'], lastActorUid: 'stu', createdAt: T0, updatedAt: T0 }, over || {});
}
/* The page stamps lastActorUid on every write and the rules require it to be the caller; these wrappers do the same for hand-written patches. */
const as = (uid, d) => (id, patch) => updateDoc(doc(d, 'procurementTickets/' + id), Object.assign({ lastActorUid: uid }, patch));
const U = { stu: as('stu', stu), oth: as('oth', oth), app: as('app', app), buy: as('buy', buy), adm: as('adm', adm), gst: as('gst', gst) };
/* A ticket as the page CREATES it: born now (createdAt == request.time), one submit entry. */
function fresh(over) { return Object.assign(ticket(), { createdAt: serverTimestamp(), updatedAt: serverTimestamp(), history: [{ id: 'h0', action: 'submit', by: (over && over.requestedBy) || 'stu' }] }, over || {}); }
async function seed(id, over) { await env.withSecurityRulesDisabled(async (c) => { await setDoc(doc(c.firestore(), 'procurementTickets/' + id), ticket(over)); }); }

await env.withSecurityRulesDisabled(async (ctx) => {
  const d = ctx.firestore();
  await setDoc(doc(d, 'users/stu'), { role: 'editor' });
  await setDoc(doc(d, 'users/oth'), { role: 'editor' });
  await setDoc(doc(d, 'users/app'), { role: 'editor' });
  await setDoc(doc(d, 'users/buy'), { role: 'contributor' });
  await setDoc(doc(d, 'users/adm'), { role: 'admin' });
  await setDoc(doc(d, 'users/gst'), { role: 'guest' });
  await setDoc(doc(d, 'userPermissions/app'), { caps: ['procurement:approve'] });
  await setDoc(doc(d, 'userPermissions/buy'), { caps: ['procurement:order'] });
});

console.log('\n── read + create ──');
await seed('r1');
await mustAllow('member reads a ticket', () => getDoc(doc(oth, 'procurementTickets/r1')));
await mustAllow('member lists tickets', () => getDocs(collection(oth, 'procurementTickets')));
await mustDeny('guest reads', () => getDoc(doc(gst, 'procurementTickets/r1')));
await mustDeny('guest creates', () => addDoc(collection(gst, 'procurementTickets'), fresh({ requestedBy: 'gst' })));
await mustAllow('member creates own request', () => addDoc(collection(stu, 'procurementTickets'), fresh()));
await mustDeny('member creates a request in someone else\'s name', () => addDoc(collection(stu, 'procurementTickets'), fresh({ requestedBy: 'oth' })));
await mustDeny('member creates already-approved', () => addDoc(collection(stu, 'procurementTickets'), fresh({ status: 'approved' })));
await mustDeny('member creates already-ordered', () => addDoc(collection(stu, 'procurementTickets'), fresh({ status: 'ordered' })));
await mustDeny('create with an empty item', () => addDoc(collection(stu, 'procurementTickets'), fresh({ itemDescription: '' })));
await mustDeny('admin creates as approved (approval is a separate write even for admins)', () => addDoc(collection(adm, 'procurementTickets'), fresh({ requestedBy: 'adm', status: 'approved' })));
await mustDeny('create with a forged approval stamp', () => addDoc(collection(stu, 'procurementTickets'), fresh({ approvedBy: 'adm', approvedAt: new Date() })));
await mustDeny('create with a forged two-entry history', () => addDoc(collection(stu, 'procurementTickets'), fresh({ history: [{ id: 'a' }, { id: 'b', action: 'approve', by: 'adm' }] })));
await mustDeny('create back-dated (createdAt is not request.time)', () => addDoc(collection(stu, 'procurementTickets'), Object.assign(fresh(), { createdAt: T0 })));
await mustDeny('create with lastActorUid set to the PI (so the PI is never told)', () => addDoc(collection(stu, 'procurementTickets'), fresh({ lastActorUid: 'adm' })));
await mustDeny('create with a pre-written notes thread', () => addDoc(collection(stu, 'procurementTickets'), fresh({ notes: [{ id: 'n', text: 'x' }] })));

console.log('\n── requester moves ──');
await seed('q1');
await mustAllow('requester edits own request (same status)', () => U.stu('q1', { itemDescription: 'PEG 8000', updatedAt: new Date() }));
await mustDeny('requester stamps approvedBy on own requested ticket (same status)', () => U.stu('q1', { approvedBy: 'stu', approvedByName: 'Sam', approvedAt: new Date(), piNotes: 'fine' }));
await mustDeny('requester flags a problem on a ticket that is not out for delivery', () => U.stu('q1', { issue: 'x', issueBy: 'stu', issueAt: 'now' }));
await seed('q1h', { history: [{ id: 'h1', action: 'submit' }] });
await mustDeny('requester replaces the history (append-only)', () => U.stu('q1h', { history: [{ id: 'forged', action: 'approve', by: 'adm' }] }));
await mustAllow('requester appends to the history', () => U.stu('q1h', { vendor: 'x', history: [{ id: 'h1', action: 'submit' }, { id: 'h2', action: 'edit' }] }));
await mustDeny('requester approves own request', () => U.stu('q1', { status: 'approved' }));
await mustDeny('requester marks own request ordered', () => U.stu('q1', { status: 'ordered' }));
await mustDeny('requester changes requestedBy', () => U.stu('q1', { requestedBy: 'oth' }));
await mustDeny('requester changes createdAt', () => U.stu('q1', { createdAt: new Date() }));
await mustDeny('other member edits someone else\'s request', () => U.oth('q1', { itemDescription: 'hacked' }));
await mustAllow('requester withdraws (requested → cancelled)', () => U.stu('q1', { status: 'cancelled' }));
await mustDeny('other member reopens a withdrawn ticket', () => U.oth('q1', { status: 'requested' }));
await mustAllow('requester reopens own withdrawn ticket', () => U.stu('q1', { status: 'requested' }));
await seed('q2', { status: 'needs_info', question: 'Which MW?' });
await mustAllow('requester answers (needs_info → requested)', () => U.stu('q2', { status: 'requested', question: null }));
await seed('q3', { status: 'needs_info' });
await mustDeny('other member answers for them', () => U.oth('q3', { status: 'requested' }));
await mustAllow('requester answers a question by EDITING (needs_info → requested, the core\'s shape)', () => U.stu('q3', { status: 'requested', vendor: 'Sigma', question: null, updatedAt: new Date(), lastActorUid: 'stu' }));
await seed('q3b', { status: 'needs_info' });
await mustDeny('requester spoofs lastActorUid', () => U.stu('q3b', { status: 'requested', lastActorUid: 'adm' }));
await seed('q4', { status: 'approved' });
await mustAllow('requester edits an approved ticket back to requested (re-approval)', () => U.stu('q4', { status: 'requested', unitCost: 99 }));
await seed('q5', { status: 'approved', approvedBy: 'app', approvedAt: T0, piNotes: 'ok' });
await mustDeny('requester edits an approved ticket and keeps it approved', () => U.stu('q5', { unitCost: 99 }));
await mustAllow('requester withdraws an approved ticket (approval stamps untouched)', () => U.stu('q5', { status: 'cancelled', cancelledBy: 'stu', cancelledAt: 'now' }));
await mustAllow('requester reopens it, CLEARING the old decision', () => U.stu('q5', { status: 'requested', cancelledBy: null, cancelledAt: null, approvedBy: null, approvedByName: null, approvedAt: null, piNotes: '' }));
await seed('q6', { status: 'denied' });
await mustDeny('requester reopens a DENIED ticket', () => U.stu('q6', { status: 'requested' }));
await seed('q7', { status: 'ordered' });
await mustDeny('requester withdraws after it was ordered', () => U.stu('q7', { status: 'cancelled' }));

console.log('\n── approver moves (cap, not admin) ──');
await seed('a1');
await mustDeny('bystander approves', () => U.oth('a1', { status: 'approved' }));
await mustDeny('purchaser (order cap) approves', () => U.buy('a1', { status: 'approved' }));
await mustAllow('approver asks a question (→ needs_info)', () => U.app('a1', { status: 'needs_info', question: 'MW?' }));
await mustAllow('approver approves from needs_info', () => U.app('a1', { status: 'approved', approvedBy: 'app' }));
await mustAllow('approver un-approves', () => U.app('a1', { status: 'requested', approvedBy: null }));
await mustAllow('approver edits a request (same status)', () => U.app('a1', { vendor: 'Sigma' }));
await mustAllow('approver denies', () => U.app('a1', { status: 'denied', piNotes: 'no' }));
await mustAllow('approver reopens a denied ticket', () => U.app('a1', { status: 'requested' }));
await seed('a4', { status: 'approved' });
await mustDeny('approver sends an APPROVED ticket to needs_info (not a table move)', () => U.app('a4', { status: 'needs_info' }));
await seed('a5', { status: 'denied' });
await mustDeny('approver flips denied straight to approved', () => U.app('a5', { status: 'approved' }));
await seed('a6', { status: 'cancelled' });
await mustDeny('approver denies a withdrawn ticket', () => U.app('a6', { status: 'denied' }));
await mustDeny('approver writes without stamping themselves as the actor', () => updateDoc(doc(app, 'procurementTickets/a4'), { piNotes: 'x', lastActorUid: 'stu' }));
await mustDeny('approver marks ordered (needs the order cap)', () => U.app('a1', { status: 'approved' }).then(() => U.app('a1', { status: 'ordered' })));
await mustDeny('approver changes requestedBy', () => U.app('a1', { requestedBy: 'app' }));
await seed('a2', { status: 'placed' });
await mustDeny('approver rewrites a placed ticket', () => U.app('a2', { status: 'requested' }));
await seed('a3', { status: 'ordered' });
await mustDeny('approver denies an ordered ticket', () => U.app('a3', { status: 'denied' }));

console.log('\n── purchaser moves (cap, not admin) ──');
await seed('b1', { status: 'approved' });
await mustDeny('bystander marks ordered', () => U.oth('b1', { status: 'ordered' }));
await mustDeny('requester marks own ordered', () => U.stu('b1', { status: 'ordered' }));
await mustAllow('purchaser marks ordered', () => U.buy('b1', { status: 'ordered', poNumber: 'PO-1', orderedBy: 'buy' }));
await mustAllow('purchaser edits the order (same status)', () => U.buy('b1', { expectedDelivery: '2026-10-30' }));
await mustDeny('purchaser changes the item or quantity under cover of the order', () => U.buy('b1', { quantity: 50, itemDescription: 'other' }));
await mustDeny('purchaser changes the funding account', () => U.buy('b1', { fundingAccount: 'mine' }));
await seed('b5', { status: 'approved' });
await mustDeny('purchaser rewrites the estimate while marking ordered', () => U.buy('b5', { status: 'ordered', estimatedCost: 0 }));
await seed('b6', { status: 'ordered', issue: 'late', issueBy: 'oth' });
await mustDeny('bystander clears a flag', () => U.oth('b6', { issue: null, issueBy: null }));
await mustAllow('purchaser clears a flag', () => U.buy('b6', { issue: null, issueBy: null, issueByName: null, issueAt: null }));
await mustAllow('purchaser undoes the order', () => U.buy('b1', { status: 'approved' }));
await seed('b2');
await mustDeny('purchaser skips approval (requested → ordered)', () => U.buy('b2', { status: 'ordered' }));
await seed('b3', { status: 'received' });
await mustAllow('purchaser un-receives', () => U.buy('b3', { status: 'ordered' }));
await seed('b4', { status: 'received' });
await mustDeny('bystander un-receives', () => U.oth('b4', { status: 'ordered' }));
await mustDeny('purchaser deletes', () => deleteDoc(doc(buy, 'procurementTickets/b4')));

console.log('\n── anyone receives and puts away ──');
await seed('c1', { status: 'ordered' });
await mustDeny('bystander marks received signed as someone else', () => U.oth('c1', { status: 'received', receivedBy: 'stu' }));
await mustAllow('bystander marks received', () => U.oth('c1', { status: 'received', receivedBy: 'oth' }));
await mustDeny('bystander rewrites the receipt afterwards (received>received is not a move the page makes)', () => U.oth('c1', { actualCost: 12 }));
await mustDeny('bystander rewrites the account/approver on a received ticket', () => U.oth('c1', { fundingAccount: 'mine', approvedBy: 'oth' }));
await mustDeny('bystander rewrites the item on a received ticket', () => U.oth('c1', { itemDescription: 'hacked' }));
await mustDeny('bystander puts away signed as someone else', () => U.oth('c1', { status: 'placed', location: 'Shelf 3', inventoryItemId: 'INV1', placedBy: 'stu' }));
await mustAllow('bystander puts away (→ placed)', () => U.oth('c1', { status: 'placed', location: 'Shelf 3', inventoryItemId: 'INV1', placedBy: 'oth' }));
await mustDeny('bystander reopens a placed ticket', () => U.oth('c1', { status: 'received' }));
await seed('c2', { status: 'approved' });
await mustDeny('bystander marks an APPROVED ticket received (must be ordered first)', () => U.oth('c2', { status: 'received' }));
await seed('c3', { status: 'ordered' });
await mustDeny('receiver changes requestedBy on the way', () => U.oth('c3', { status: 'received', requestedBy: 'oth' }));
await mustDeny('receiver rewrites the account and item on the way', () => U.oth('c3', { status: 'received', fundingAccount: 'x', itemDescription: 'y' }));
await mustDeny('receiver spoofs lastActorUid on the way', () => U.oth('c3', { status: 'received', lastActorUid: 'stu' }));
await mustAllow('receiver writes exactly the page\'s receive shape', () => U.oth('c3', { status: 'received', quantityReceived: 1, actualCost: 9.5, receiptUrl: '', receiptStoragePath: '', receivedNote: 'ok', receivedBy: 'oth', receivedByName: 'Otto', receivedAt: new Date(), updatedAt: new Date(), lastActorUid: 'oth', lastActivityAt: 'now', history: [{ id: 'h' }], watcherUids: ['stu', 'oth'] }));
await mustDeny('placer rewrites the cost on the way', () => U.oth('c3', { status: 'placed', location: 'Shelf', inventoryItemId: 'i', actualCost: 0 }));
await mustAllow('placer writes exactly the page\'s place shape', () => U.oth('c3', { status: 'placed', location: 'Shelf', placementMode: 'new', inventoryItemId: 'i', placedBy: 'oth', placedByName: 'Otto', placedAt: new Date(), updatedAt: new Date(), lastActorUid: 'oth', lastActivityAt: 'now', history: [{ id: 'h' }, { id: 'h2' }], watcherUids: ['stu', 'oth'] }));

console.log('\n── notes, flags, watchers (same status, any member) ──');
await seed('n1', { status: 'approved' });
await mustAllow('bystander adds a note', () => U.oth('n1', { notes: [{ id: 'x', text: 'any news?', by: 'oth' }], history: [{ id: 'h', action: 'note' }], updatedAt: new Date(), watcherUids: ['stu', 'oth'], lastActorUid: 'oth', lastActivityAt: 'now' }));
await mustDeny('bystander edits the item under cover of a note', () => U.oth('n1', { notes: [], itemDescription: 'hacked' }));
await mustDeny('bystander sets approvedBy under cover of a note', () => U.oth('n1', { notes: [], approvedBy: 'oth' }));
await seed('n2', { status: 'ordered' });
await mustAllow('bystander flags a problem', () => U.oth('n2', { issue: 'wrong item', issueBy: 'oth', issueByName: 'Otto', issueAt: 'now', updatedAt: new Date(), lastActorUid: 'oth', lastActivityAt: 'now' }));
await seed('n3', { status: 'placed' });
await mustAllow('a note on a placed ticket still works', () => U.oth('n3', { notes: [{ id: 'x' }], updatedAt: new Date() }));
await seed('n4', { status: 'approved', history: [{ id: 'h1' }], notes: [{ id: 'n1' }], watcherUids: ['stu', 'app'] });
await mustDeny('member REPLACES the notes thread', () => U.oth('n4', { notes: [{ id: 'mine' }] }));
await mustDeny('member drops a watcher', () => U.oth('n4', { watcherUids: ['stu'] }));
await mustAllow('member appends (hasAll the old entries)', () => U.oth('n4', { notes: [{ id: 'n1' }, { id: 'n2' }], history: [{ id: 'h1' }, { id: 'h2' }], watcherUids: ['stu', 'app', 'oth'] }));
await env.withSecurityRulesDisabled(async (c) => { await setDoc(doc(c.firestore(), 'procurementTickets/nostatus'), { requestedBy: 'stu', itemDescription: 'legacy', createdAt: T0 }); });
await mustAllow('a V3.44 ticket with NO status field: member notes it (tTo defaults to requested)', () => U.oth('nostatus', { notes: [{ id: 'n' }] }));
await mustAllow('… and its requester edits it', () => U.stu('nostatus', { vendor: 'Sigma' }));
await mustDeny('guest adds a note', () => U.gst('n3', { notes: [{ id: 'y' }] }));

console.log('\n── V3.814: change funding at any stage (approver cap); the new request fields ──');
const FUND = { projectId: 'onr', project: 'ONR', fundingAccount: '3062920', fundingLabel: 'ONR · 3062920', fundingChangedBy: 'app', fundingChangedByName: 'Ava', fundingChangedAt: 'now', fundingChangedFrom: 'Startup · 1101935', updatedAt: new Date(), lastActivityAt: 'now', history: [{ id: 'h1' }, { id: 'h2', action: 'reassign' }], notes: [{ id: 'n1', kind: 'funding' }], watcherUids: ['stu', 'app'] };
await seed('f1', { status: 'ordered', fundingAccount: '1101935', fundingLabel: 'Startup · 1101935', history: [{ id: 'h1' }], notes: [], watcherUids: ['stu'] });
await mustAllow('approver changes the funding on an ORDERED ticket (exact page shape)', () => U.app('f1', FUND));
await seed('f2', { status: 'ordered', fundingAccount: '1101935', history: [{ id: 'h1' }], notes: [], watcherUids: ['stu'] });
await mustDeny('purchaser changes the funding on an ordered ticket', () => U.buy('f2', FUND));
await mustDeny('bystander changes the funding on an ordered ticket', () => U.oth('f2', FUND));
await mustDeny('requester changes the funding on an ordered ticket', () => U.stu('f2', FUND));
await mustDeny('approver smuggles a PO change in with the funding change', () => U.app('f2', Object.assign({}, FUND, { poNumber: 'PO-X' })));
await mustDeny('approver smuggles an item change in with the funding change', () => U.app('f2', Object.assign({}, FUND, { itemDescription: 'other' })));
await mustDeny('approver smuggles a status move in with the funding change', () => U.app('f2', Object.assign({}, FUND, { status: 'received' })));
await mustDeny('approver rewrites the approval stamp under cover of a funding change', () => U.app('f2', Object.assign({}, FUND, { approvedBy: 'app' })));
await seed('f3', { status: 'received', fundingAccount: '1101935', history: [{ id: 'h1' }], notes: [], watcherUids: ['stu'] });
await mustAllow('approver changes the funding on a RECEIVED ticket', () => U.app('f3', FUND));
await seed('f4', { status: 'placed', fundingAccount: '1101935', history: [{ id: 'h1' }], notes: [], watcherUids: ['stu'] });
await mustAllow('approver changes the funding on a PLACED ticket', () => U.app('f4', FUND));
await seed('f5', { status: 'approved', fundingAccount: '1101935', history: [{ id: 'h1' }], notes: [], watcherUids: ['stu'] });
await mustAllow('approver changes the funding on an APPROVED ticket (approved>approved)', () => U.app('f5', FUND));
await seed('f6', { status: 'denied', fundingAccount: '1101935', history: [{ id: 'h1' }], notes: [], watcherUids: ['stu'] });
await mustDeny('approver changes the funding on a DENIED ticket (not a live stage)', () => U.app('f6', FUND));
await seed('f7', { status: 'ordered', fundingAccount: '1101935', history: [{ id: 'h1' }], notes: [], watcherUids: ['stu'] });
await mustDeny('approver changes the funding without stamping themselves as actor', () => updateDoc(doc(app, 'procurementTickets/f7'), Object.assign({}, FUND, { lastActorUid: 'stu' })));
await mustAllow('member creates a request with purchase type + a price comparison', () => addDoc(collection(stu, 'procurementTickets'), fresh({ purchaseType: 'recurring', recurrence: 'monthly', comparisons: [{ vendor: 'Fisher', unitPrice: 12.5, chosen: true }, { vendor: 'VWR', unitPrice: 11 }], repeatOf: 'older' })));
await seed('f8');
await mustAllow('requester edits the purchase type + comparison (same status)', () => U.stu('f8', { purchaseType: 'one_time', recurrence: '', comparisons: [{ vendor: 'A', unitPrice: 1 }] }));
await mustDeny('bystander edits the comparison on someone else\'s request', () => U.oth('f8', { comparisons: [] }));
await seed('f9', { status: 'ordered' });
await mustDeny('purchaser edits the comparison under cover of the order', () => U.buy('f9', { comparisons: [] }));

console.log('\n── V3.820: price watch (any member starts/extends; history append-only; creator frozen) ──');
const W = (over) => Object.assign({ url: 'https://www.vwr.com/us/en/product/37358545/x', normUrl: 'vwr.com/us/en/product/37358545/x', host: 'vwr.com', vendor: 'VWR', catalogueNumber: '76520-944', name: 'Tubes', currency: 'USD',
  latest: { at: '2026-10-22T12:00:00Z', price: 246.57, method: 'capture', by: 'stu' }, history: [{ at: '2026-10-22T12:00:00Z', price: 246.57, method: 'capture', by: 'stu' }],
  lastCheckedAt: '2026-10-22T12:00:00Z', nextCheckAt: '2027-01-20T12:00:00Z', checkEveryDays: 90, status: 'active', failures: 0, lastError: null, claimedAt: null, claimedBy: null,
  inventoryItemId: null, ticketIds: [], createdAt: '2026-10-22T12:00:00Z', createdBy: 'stu', updatedAt: '2026-10-22T12:00:00Z', lastActorUid: 'stu' }, over || {});
await mustAllow('member starts a watch (createdBy + lastActorUid = self)', () => setDoc(doc(stu, 'priceWatch/w1'), W()));
await mustDeny('member starts a watch in someone else\'s name', () => setDoc(doc(stu, 'priceWatch/w2'), W({ createdBy: 'oth', lastActorUid: 'stu' })));
await mustDeny('member starts a watch spoofing the actor', () => setDoc(doc(stu, 'priceWatch/w3'), W({ lastActorUid: 'oth' })));
await mustDeny('guest starts a watch', () => setDoc(doc(gst, 'priceWatch/w4'), W({ createdBy: 'gst', lastActorUid: 'gst' })));
await mustAllow('member reads watches', () => getDoc(doc(oth, 'priceWatch/w1')));
await mustDeny('guest reads watches', () => getDoc(doc(gst, 'priceWatch/w1')));
const H2 = [{ at: '2026-10-22T12:00:00Z', price: 246.57, method: 'capture', by: 'stu' }, { at: '2027-01-21T12:00:00Z', price: 250, method: 'rescrape', by: 'oth' }];
await mustAllow('ANOTHER member appends an observation (the quarterly re-scrape runs in whoever\'s browser)', () => updateDoc(doc(oth, 'priceWatch/w1'), { history: H2, latest: H2[1], lastActorUid: 'oth', updatedAt: 'now' }));
await mustDeny('member replaces the history', () => updateDoc(doc(oth, 'priceWatch/w1'), { history: [H2[1]], lastActorUid: 'oth' }));
await mustDeny('member changes the creator', () => updateDoc(doc(oth, 'priceWatch/w1'), { createdBy: 'oth', lastActorUid: 'oth' }));
await mustDeny('member writes without stamping themselves as actor', () => updateDoc(doc(oth, 'priceWatch/w1'), { failures: 1, lastActorUid: 'stu' }));
await mustAllow('member leases a watch for a re-check (claimedAt/claimedBy)', () => updateDoc(doc(oth, 'priceWatch/w1'), { claimedAt: 'now', claimedBy: 'oth', lastActorUid: 'oth', updatedAt: 'now' }));
await mustAllow('member records a failed check', () => updateDoc(doc(oth, 'priceWatch/w1'), { failures: 1, lastError: 'no price', nextCheckAt: '2027-01-28T12:00:00Z', status: 'active', claimedAt: null, claimedBy: null, lastActorUid: 'oth', updatedAt: 'now' }));
await mustAllow('member saves the page as printed text (snapshot, by = self)', () => setDoc(doc(stu, 'priceWatch/w1/snapshots/s1'), { at: 'now', url: 'https://www.vwr.com/x', title: 'Tubes', text: 'Centrifuge Tubes … $246.57', price: 246.57, currency: 'USD', method: 'capture', by: 'stu' }));
await mustDeny('member saves a snapshot as someone else', () => setDoc(doc(stu, 'priceWatch/w1/snapshots/s2'), { at: 'now', text: 'x', by: 'oth' }));
await mustDeny('snapshots are write-once', () => updateDoc(doc(stu, 'priceWatch/w1/snapshots/s1'), { text: 'rewritten' }));
await mustAllow('member reads a snapshot', () => getDoc(doc(oth, 'priceWatch/w1/snapshots/s1')));
await mustDeny('member deletes a watch', () => deleteDoc(doc(stu, 'priceWatch/w1')));
await mustAllow('admin deletes a watch', () => deleteDoc(doc(adm, 'priceWatch/w1')));

console.log('\n── documents (V3.881) ──');
const DOC = (id, over) => Object.assign({ kind: 'receipt', fileName: 'r.pdf', contentType: 'application/pdf', size: 10, storagePath: 'procurement/docs/' + id + '/r.pdf', url: 'https://u',
  ticketIds: ['t1'], poNumber: '', vendor: '', docDate: '', note: '', source: 'upload', uploadedBy: 'buy', uploadedByName: 'Bo', uploadedAt: serverTimestamp(), updatedAt: serverTimestamp(),
  ingestStatus: 'pending', ingestedAt: null, ingestedItemIds: [], ingestNote: '' }, over || {});
await mustAllow('purchaser files a receipt', () => setDoc(doc(buy, 'procurementDocs/d1'), DOC('d1')));
await mustAllow('purchaser files a requisition that covers no request yet', () => setDoc(doc(buy, 'procurementDocs/d2'), DOC('d2', { kind: 'requisition', ticketIds: [] })));
await mustAllow('approver files a document', () => setDoc(doc(app, 'procurementDocs/d3'), DOC('d3', { uploadedBy: 'app' })));
await mustAllow('a member files a receipt FOR a request (the Receive form)', () => setDoc(doc(stu, 'procurementDocs/d4'), DOC('d4', { uploadedBy: 'stu' })));
await mustDeny('a member files a document that covers no request', () => setDoc(doc(stu, 'procurementDocs/d5'), DOC('d5', { uploadedBy: 'stu', ticketIds: [] })));
await mustDeny('filed in someone else’s name', () => setDoc(doc(buy, 'procurementDocs/d6'), DOC('d6', { uploadedBy: 'stu' })));
await mustDeny('a path outside procurement/docs/{docId}/', () => setDoc(doc(buy, 'procurementDocs/d7'), DOC('d7', { storagePath: 'procurement/other/r.pdf' })));
await mustDeny('another doc’s folder', () => setDoc(doc(buy, 'procurementDocs/d8'), DOC('d8', { storagePath: 'procurement/docs/d1/r.pdf' })));
await mustDeny('an unknown kind', () => setDoc(doc(buy, 'procurementDocs/d9'), DOC('d9', { kind: 'selfie' })));
await mustDeny('born already ingested', () => setDoc(doc(buy, 'procurementDocs/d10'), DOC('d10', { ingestStatus: 'ingested' })));
await mustDeny('more than 50 requests', () => setDoc(doc(buy, 'procurementDocs/d11'), DOC('d11', { ticketIds: Array.from({ length: 51 }, (_, i) => 'x' + i) })));
await mustDeny('a guest files', () => setDoc(doc(gst, 'procurementDocs/d12'), DOC('d12', { uploadedBy: 'gst' })));
await mustAllow('a member reads a document', () => getDoc(doc(oth, 'procurementDocs/d1')));
await mustAllow('a member lists documents', () => getDocs(collection(oth, 'procurementDocs')));
await mustDeny('a guest reads', () => getDoc(doc(gst, 'procurementDocs/d1')));
await mustAllow('purchaser relabels and relinks', () => updateDoc(doc(buy, 'procurementDocs/d1'), { kind: 'invoice', ticketIds: ['t1', 't2'], poNumber: 'PO-1', vendor: 'Fisher', docDate: '2026-10-20', note: 'n', updatedAt: serverTimestamp() }));
await mustAllow('approver edits a purchaser’s document', () => updateDoc(doc(app, 'procurementDocs/d1'), { note: 'checked' }));
await mustAllow('the later inventory step marks it ingested', () => updateDoc(doc(buy, 'procurementDocs/d1'), { ingestStatus: 'ingested', ingestedAt: serverTimestamp(), ingestedItemIds: ['inv-1'] }));
await mustAllow('the member who filed it edits their note', () => updateDoc(doc(stu, 'procurementDocs/d4'), { note: 'box 2' }));
await mustDeny('another member edits it', () => updateDoc(doc(oth, 'procurementDocs/d4'), { note: 'x' }));
await mustDeny('the file path is frozen', () => updateDoc(doc(buy, 'procurementDocs/d1'), { storagePath: 'procurement/docs/d1/other.pdf' }));
await mustDeny('the uploader is frozen', () => updateDoc(doc(buy, 'procurementDocs/d1'), { uploadedBy: 'adm' }));
await mustDeny('an edit to an unknown kind', () => updateDoc(doc(buy, 'procurementDocs/d1'), { kind: 'selfie' }));
await mustDeny('another member deletes it', () => deleteDoc(doc(oth, 'procurementDocs/d4')));
await mustDeny('a purchaser deletes someone else’s', () => deleteDoc(doc(buy, 'procurementDocs/d4')));
await mustAllow('the uploader deletes their own', () => deleteDoc(doc(stu, 'procurementDocs/d4')));
await mustAllow('an admin deletes any', () => deleteDoc(doc(adm, 'procurementDocs/d3')));

console.log('\n── admin ──');
await seed('d1', { status: 'placed' });
await mustAllow('admin rewinds a placed ticket', () => U.adm('d1', { status: 'received' }));
await mustAllow('admin approves', () => U.adm('d1', { status: 'approved' }));
await mustAllow('admin orders', () => U.adm('d1', { status: 'ordered' }));
await mustAllow('admin reassigns the requester', () => U.adm('d1', { requestedBy: 'oth' }));
await mustDeny('member deletes', () => deleteDoc(doc(stu, 'procurementTickets/d1')));
await mustAllow('admin deletes', () => deleteDoc(doc(adm, 'procurementTickets/d1')));

console.log(`\nProcurement rules — ${ok} ok, ${holes} HOLE, ${breaks} BREAK`);
await env.cleanup();
process.exit(holes + breaks ? 1 : 0);
