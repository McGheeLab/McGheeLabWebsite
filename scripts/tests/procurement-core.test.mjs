/* procurement-core.test.mjs — V3.813 state machine, pure logic.
 *   node scripts/tests/procurement-core.test.mjs
 * Runs the SAME bytes the page ships (rm/js/procurement-core.js) with no
 * DOM and no Firebase. Pins: who may do what at each stage, validation,
 * the patch each action writes, the inbox per role, report math, CSV,
 * the restock plan, and the legacy-ticket timeline. */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const C = require('../../rm/js/procurement-core.js');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  FAIL ' + m); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), m + ' → got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b));
const STAMP = { __stamp: true };
const NOW = Date.parse('2026-10-19T15:00:00Z');

const student = C.actorFrom({ uid: 'stu', email: 's@x' }, { name: 'Sam Student', role: 'editor' }, () => false);
const other   = C.actorFrom({ uid: 'oth', email: 'o@x' }, { name: 'Otto Other', role: 'editor' }, () => false);
const approver= C.actorFrom({ uid: 'app' }, { name: 'Ava Approver', role: 'editor' }, (c) => c === 'procurement:approve');
const buyer   = C.actorFrom({ uid: 'buy' }, { name: 'Bo Buyer', role: 'editor' }, (c) => c === 'procurement:order');
const mgr     = C.actorFrom({ uid: 'mgr' }, { name: 'Mia Manager', role: 'editor' }, (c) => c === 'inventory:manage');
const admin   = C.actorFrom({ uid: 'pi' }, { name: 'The PI', role: 'admin' }, () => false);

/* apply a patch + appends locally, the way the page mirrors a write */
function apply(t, r) {
  if (r.error) throw new Error(r.error);
  Object.keys(r.patch).forEach((k) => { t[k] = r.patch[k] === STAMP ? new Date(NOW) : r.patch[k]; });
  t.history = (t.history || []).concat(r.appends.history);
  t.notes = (t.notes || []).concat(r.appends.notes);
  r.appends.watcherUids.forEach((u) => { if (t.watcherUids.indexOf(u) < 0) t.watcherUids.push(u); });
  return t;
}
const FP = [{ id: 'mcghee-startup', name: 'McGhee Startup', account_number: '1101935', status: 'active' }, { id: 'prostate', name: 'Cancer Engineering - Prostate', account_number: '1101917', funding_string: '1101917-MCMI', status: 'active' }, { id: 'old', name: 'Expired', account_number: '1', status: 'expired' }];
const OPTS = C.fundedProjectOptions(FP, []);
function make(values, actor, extra) {
  const r = C.buildCreate(Object.assign({ project: 'Test project', fundingAccount: '1101935', fundingLabel: 'McGhee Startup · 1101935', purchaseType: 'one_time' }, values), actor || student, NOW, STAMP, extra);
  if (r.error) throw new Error(r.error);
  const t = Object.assign({ id: 'T' + Math.random().toString(36).slice(2, 7) }, r.data);
  t.createdAt = new Date(NOW); t.updatedAt = new Date(NOW);
  return t;
}

console.log('── actors ──');
ok(admin.isAdmin && admin.canApprove && admin.canOrder && admin.isInvMgr, 'admin holds every role');
ok(!student.canApprove && !student.canOrder && !student.isInvMgr, 'student holds none');
ok(approver.canApprove && !approver.canOrder, 'approver cap only approves');
ok(buyer.canOrder && !buyer.canApprove, 'order cap only orders');

console.log('── create + validation ──');
eq(C.buildCreate({ reason: 'x' }, student, NOW, STAMP).field, 'itemDescription', 'item required');
eq(C.buildCreate({ itemDescription: 'PEG' }, student, NOW, STAMP).field, 'reason', 'reason required');
eq(C.buildCreate({ itemDescription: 'PEG', reason: 'r' }, student, NOW, STAMP).field, 'projectId', 'project required (it decides the funding string)');
eq(C.buildCreate({ itemDescription: 'PEG', reason: 'r', projectId: '__other', project: 'Side thing' }, student, NOW, STAMP).field, 'purchaseType', 'one-time vs recurring is required (V3.814)');
ok(!C.buildCreate({ itemDescription: 'PEG', reason: 'r', projectId: '__other', project: 'Side thing', purchaseType: 'one_time' }, student, NOW, STAMP).error, 'Other… with a name typed is fine (approver assigns the funding string)');
eq(C.buildCreate({ itemDescription: 'PEG', reason: 'r', productUrl: 'sigma.com/x' }, student, NOW, STAMP).field, 'productUrl', 'url must be http(s)');
eq(C.buildCreate({ itemDescription: 'PEG', reason: 'r', productUrl: 'https://x.com/" onmouseover="alert(1)' }, student, NOW, STAMP).field, 'productUrl', 'url with a quote is refused (attribute breakout)');
eq(C.buildCreate({ itemDescription: 'PEG', reason: 'r', neededBy: 'soon' }, student, NOW, STAMP).field, 'neededBy', 'neededBy must be a date');
{
  const t = make({ itemDescription: ' PEG 6000 ', reason: 'gels', quantity: '3', unitCost: '12.5', category: 'reagent', urgency: 'urgent', fundingAccount: '1101935', fundingLabel: 'Startup (1101935)', neededBy: '2026-11-01' });
  eq(t.itemDescription, 'PEG 6000', 'trims');
  eq(t.estimatedCost, 37.5, 'estimate = unit × qty');
  eq(t.status, 'requested', 'starts requested');
  eq(t.history.length, 1, 'one history entry');
  eq(t.history[0].action, 'submit', 'submit entry');
  eq(t.watcherUids, ['stu'], 'requester watches');
  eq(t.lastActorUid, 'stu', 'actor stamped');
  eq(t.requesterName, 'Sam Student', 'name from profile');
  eq(t.inventoryItemId, null, 'no restock target by default');
  const r = make({ itemDescription: 'x', reason: 'y' }, student, { inventoryItemId: 'INV1', source: 'reorder' });
  eq(r.inventoryItemId, 'INV1', 'reorder carries the inventory id');
  eq(C.validateRequest({ itemDescription: 'x', reason: 'y', quantity: '-4' }).field, 'quantity', 'negative qty refused');
  eq(C.validateRequest({ itemDescription: 'x', reason: 'y', quantity: '0' }).field, 'quantity', 'zero qty refused');
  eq(C.validateRequest({ itemDescription: 'x', reason: 'y', unitCost: '-1' }).field, 'unitCost', 'negative cost refused');
  eq(C.validateRequest({ itemDescription: 'x', reason: 'y', unitCost: '$12.50' }).field, 'unitCost', '$ sign refused');
  eq(C.validateRequest({ itemDescription: 'x', reason: 'y', unitCost: '12abc' }).field, 'unitCost', '12abc refused');
  eq(C.validateRequest({ itemDescription: 'x', reason: 'y', unitCost: '1e309' }).field, 'unitCost', 'exponent/Infinity refused');
  eq(C.validateRequest({ itemDescription: 'x', reason: 'y', neededBy: '2026-02-30' }).field, 'neededBy', 'Feb 30 is not a date');
  eq(C.validateRequest({ itemDescription: 'x', reason: 'y', projectId: '__other', project: '' }).field, 'projectId', 'Other… with no project name typed refused');
  eq(make({ itemDescription: 'x', reason: 'y', category: '', urgency: 'nope' }).category, 'consumable', 'empty category → consumable');
  eq(make({ itemDescription: 'x', reason: 'y', category: 'research_gels' }).category, 'research_gels', 'a legacy category is kept, not re-filed');
}

console.log('── who may do what ──');
{
  const t = make({ itemDescription: 'PEG', reason: 'r' });
  eq(C.availableActions(t, student), ['edit', 'cancel', 'note'], 'requester on requested');
  eq(C.availableActions(t, other), ['note'], 'bystander on requested');
  eq(C.availableActions(t, approver), ['approve', 'ask', 'deny', 'edit', 'reassign', 'note'], 'approver on requested');
  eq(C.availableActions(t, buyer), ['note'], 'buyer on requested (approval first)');
  eq(C.availableActions(t, admin), ['approve', 'ask', 'deny', 'edit', 'reassign', 'note', 'delete'], 'admin on requested');
  ok(!C.can('approve', t, student), 'requester cannot approve own');
  ok(!C.can('answer', t, student), 'no answer without a question');
  t.status = 'needs_info';
  eq(C.availableActions(t, student), ['answer', 'edit', 'cancel', 'note'], 'requester answers a question');
  eq(C.availableActions(t, approver), ['approve', 'deny', 'edit', 'reassign', 'note'], 'approver can still decide during a question');
  eq(C.targetStatus('edit', t, student), 'requested', 'a requester EDIT during a question answers it (→ requested)');
  eq(C.targetStatus('edit', t, approver), 'needs_info', 'an approver edit during a question leaves it open');
  { const tq = Object.assign({}, t, { question: 'Which MW?' });
    const re = C.buildPatch('edit', tq, Object.assign(C.cleanRequest(tq), { vendor: 'Sigma' }), student, NOW, STAMP);
    eq([re.to, re.patch.question, /answers the open question/.test(re.appends.history[0].note)], ['requested', null, true], 'edit-as-answer clears the question and says so'); }
  t.status = 'approved';
  eq(C.availableActions(t, buyer), ['order', 'note'], 'buyer orders an approved ticket');
  eq(C.availableActions(t, student), ['edit', 'cancel', 'note'], 'requester may still edit/withdraw before order');
  eq(C.availableActions(t, approver), ['deny', 'edit', 'unapprove', 'reassign', 'note'], 'approver can undo');
  t.status = 'ordered';
  eq(C.availableActions(t, student), ['receive', 'flag', 'note'], 'anyone receives / flags');
  eq(C.availableActions(t, buyer), ['receive', 'edit_order', 'unorder', 'flag', 'note'], 'buyer edits/undoes order');
  t.issue = 'wrong item';
  ok(!C.can('flag', t, student) && C.can('clear_issue', t, buyer) && !C.can('clear_issue', t, student), 'flag once; only purchaser clears');
  t.issue = null; t.status = 'received';
  eq(C.availableActions(t, other), ['place', 'flag', 'note'], 'anyone puts away');
  ok(C.can('unreceive', t, buyer) && !C.can('unreceive', t, other), 'only purchaser un-receives');
  t.status = 'placed';
  eq(C.availableActions(t, student), ['note'], 'placed is terminal for members');
  eq(C.availableActions(t, admin), ['reassign', 'note', 'delete'], 'admin can still delete (and change funding on a placed ticket)');
  t.status = 'cancelled';
  ok(C.can('reopen', t, student) && !C.can('reopen', t, other) && C.can('reopen', t, approver), 'requester or approver reopens a withdrawn ticket');
  t.status = 'denied';
  ok(!C.can('reopen', t, student) && C.can('reopen', t, approver), 'only approver reopens a denied ticket');
}

console.log('── patches ──');
{
  const t = make({ itemDescription: 'PEG', reason: 'r' });
  eq(C.buildPatch('ask', t, { note: '' }, approver, NOW, STAMP).field, 'note', 'ask needs the question');
  eq(C.buildPatch('deny', t, {}, approver, NOW, STAMP).field, 'note', 'deny needs a reason');
  eq(C.buildPatch('approve', t, {}, student, NOW, STAMP).error.indexOf('can’t') >= 0, true, 'disallowed action errors');
  let r = C.buildPatch('ask', t, { note: 'Which MW?' }, approver, NOW, STAMP);
  eq(r.to, 'needs_info', 'ask → needs_info');
  eq(r.patch.question, 'Which MW?', 'question stored');
  eq(r.appends.notes[0].kind, 'question', 'question in the thread');
  eq(r.appends.history[0].from + '>' + r.appends.history[0].to, 'requested>needs_info', 'history from/to');
  apply(t, r);
  r = C.buildPatch('answer', t, { note: '6000' }, student, NOW, STAMP); apply(t, r);
  eq(t.status + '/' + t.question, 'requested/null', 'answer clears the question and returns to requested');
  r = C.buildPatch('approve', t, { note: 'go' }, approver, NOW, STAMP); apply(t, r);
  eq([t.status, t.approvedBy, t.piNotes, t.approvedAt instanceof Date], ['approved', 'app', 'go', true], 'approve stamps');
  // requester edits an approved ticket → back to requested, approval cleared
  r = C.buildPatch('edit', t, Object.assign(C.cleanRequest(t), { unitCost: 99 }), student, NOW, STAMP);
  eq(r.to, 'requested', 'requester edit after approval needs re-approval');
  eq(r.patch.approvedBy, null, 'approval cleared');
  ok(/Changed unit cost, estimated total/.test(r.appends.history[0].note), 'history names the changed fields in plain words: ' + r.appends.history[0].note);
  eq(C.buildPatch('edit', t, C.cleanRequest(t), approver, NOW, STAMP).error, 'Nothing changed.', 'no-op edit refused');
  const r2 = C.buildPatch('edit', t, Object.assign(C.cleanRequest(t), { vendor: 'Sigma' }), approver, NOW, STAMP);
  eq(r2.to, 'approved', 'approver edit keeps approval');
  apply(t, r2);
  eq(C.buildPatch('order', t, { purchaseMethod: 'nope' }, buyer, NOW, STAMP).field, 'purchaseMethod', 'order needs a method');
  eq(C.buildPatch('order', t, { purchaseMethod: 'pcard', orderDate: 'x' }, buyer, NOW, STAMP).field, 'orderDate', 'order date validated');
  r = C.buildPatch('order', t, { purchaseMethod: 'pcard', poNumber: 'PO-1', expectedDelivery: '2026-10-25', actualCost: '40', orderGroupId: 'G1' }, buyer, NOW, STAMP);
  eq([r.to, r.patch.orderedBy, r.patch.orderedCost, r.patch.orderGroupId, r.patch.orderDate], ['ordered', 'buy', 40, 'G1', C.todayStr(NOW)], 'order patch');
  ok(/PO PO-1, ETA 2026-10-25/.test(r.appends.history[0].note), 'order history note');
  apply(t, r);
  eq(C.buildPatch('receive', t, { quantityReceived: 'x' }, other, NOW, STAMP).field, 'quantityReceived', 'receive qty validated');
  r = C.buildPatch('receive', t, { quantityReceived: '', actualCost: '41.20', note: 'one bottle dented' }, other, NOW, STAMP);
  eq([r.to, r.patch.quantityReceived, r.patch.actualCost, r.patch.receivedBy, r.patch.receivedNote], ['received', 1, 41.2, 'oth', 'one bottle dented'], 'receive patch defaults qty to ordered');
  apply(t, r);
  eq(C.buildPatch('place', t, { location: '' }, student, NOW, STAMP).field, 'location', 'place needs a location');
  eq(C.buildPatch('place', t, { location: 'Shelf 3', mode: 'restock' }, student, NOW, STAMP).field, 'inventoryItemId', 'restock needs an item');
  r = C.buildPatch('place', t, { location: 'Shelf 3', mode: 'new', inventoryItemId: 'INV9' }, student, NOW, STAMP);
  eq([r.to, r.patch.location, r.patch.inventoryItemId, r.patch.placementMode], ['placed', 'Shelf 3', 'INV9', 'new'], 'place patch');
  apply(t, r);
  eq(C.timelineOf(t).map((h) => h.action), ['submit', 'ask', 'answer', 'approve', 'edit', 'order', 'receive', 'place'], 'full timeline');
  eq(t.watcherUids.sort(), ['app', 'buy', 'oth', 'stu'], 'everyone who acted watches');
  // every write stamps the actor + activity
  ok(t.lastActorUid === 'stu' && typeof t.lastActivityAt === 'string', 'actor + activity stamped');
}
{
  const t = make({ itemDescription: 'PEG', reason: 'r' });
  const r = C.buildPatch('note', t, { note: 'any update?' }, other, NOW, STAMP);
  ok(Object.keys(r.patch).every((k) => C.NOTE_ONLY_KEYS.indexOf(k) >= 0), 'note patch touches only NOTE_ONLY_KEYS: ' + Object.keys(r.patch));
  eq(C.buildPatch('note', t, { note: '  ' }, other, NOW, STAMP).field, 'note', 'empty note refused');
  t.status = 'ordered';
  const f = C.buildPatch('flag', t, { note: 'backordered' }, other, NOW, STAMP);
  ok(Object.keys(f.patch).every((k) => C.NOTE_ONLY_KEYS.indexOf(k) >= 0) && f.patch.issue === 'backordered', 'flag is a note-only write');
  apply(t, f);
  const c = C.buildPatch('clear_issue', t, {}, buyer, NOW, STAMP);
  eq(c.patch.issue, null, 'clear flag');
  const d = C.buildPatch('deny', t, { note: 'too expensive' }, approver, NOW, STAMP);
  ok(d.error, 'cannot deny an ordered ticket');
  t.status = 'requested';
  const d2 = C.buildPatch('deny', t, { note: 'too expensive' }, approver, NOW, STAMP);
  eq([d2.to, d2.patch.piNotes, d2.patch.deniedBy], ['denied', 'too expensive', 'app'], 'deny patch');
  const del = C.buildPatch('delete', t, {}, admin, NOW, STAMP);
  ok(del.deleteDoc === true && del.patch === null, 'delete marks the doc');
  const cx = C.buildPatch('cancel', t, {}, student, NOW, STAMP); apply(t, cx);
  eq(t.status, 'cancelled', 'withdraw');
  const ro = C.buildPatch('reopen', t, {}, student, NOW, STAMP);
  eq(ro.to, 'requested', 'requester reopens own withdrawn ticket');
}

console.log('── batch ordering ──');
{
  const a = make({ itemDescription: 'A', reason: 'r', vendor: 'Sigma-Aldrich' }); a.status = 'approved';
  const b = make({ itemDescription: 'B', reason: 'r', vendor: 'sigma aldrich' }); b.status = 'approved';
  const c = make({ itemDescription: 'C', reason: 'r', vendor: 'Sigma-Aldrich' }); c.status = 'requested';
  const d = make({ itemDescription: 'D', reason: 'r', vendor: 'Fisher' }); d.status = 'approved';
  const e = make({ itemDescription: 'E', reason: 'r', vendor: '' }); e.status = 'approved';
  eq(C.batchCandidates([a, b, c, d, e], a).map((t) => t.itemDescription), ['B'], 'same vendor (normalized), approved only, not itself');
  eq(C.batchCandidates([a, b, c, d, e], e), [], 'no vendor → no batch');
}

console.log('── inbox per role ──');
{
  const req = make({ itemDescription: 'R', reason: 'r' });
  const q = make({ itemDescription: 'Q', reason: 'r' }); q.status = 'needs_info';
  const ap = make({ itemDescription: 'AP', reason: 'r' }, other); ap.status = 'approved';
  const od = make({ itemDescription: 'OD', reason: 'r' }, other); od.status = 'ordered'; od.issue = 'late';
  const rc = make({ itemDescription: 'RC', reason: 'r' }, other); rc.status = 'received';
  const pl = make({ itemDescription: 'PL', reason: 'r' }); pl.status = 'placed';
  const all = [req, q, ap, od, rc, pl];
  eq(C.inboxFor(all, student).map((s) => s.key + ':' + s.items.length), ['answer:1', 'place:1', 'mine:1'], 'student: answer, put away, own open');
  eq(C.inboxFor(all, approver).map((s) => s.key + ':' + s.items.length), ['approve:1', 'place:1'], 'approver: approvals + arrivals');
  eq(C.inboxFor(all, buyer).map((s) => s.key + ':' + s.items.length), ['order:1', 'issues:1', 'place:1'], 'buyer: orders, issues, arrivals');
  eq(C.inboxFor(all, admin).map((s) => s.key), ['approve', 'order', 'issues', 'place'], 'admin sees everything');
  { const own = make({ itemDescription: 'OWN', reason: 'r' }, approver);
    eq(C.inboxFor([own], approver).map((s) => s.key + ':' + s.items.length), ['approve:1'], 'an approver\'s own request shows once (approvals), not again under mine'); }
  eq(C.inboxFor([], student), [], 'empty inbox is empty');
  const c = C.counts(all, 'stu');
  eq([c.active, c.archive, c.mine, c.requested, c.placed], [5, 1, 3, 1, 1], 'counts');
  eq(C.filterTickets(all, { view: 'archive' }).length, 1, 'archive = inactive');
  eq(C.filterTickets(all, { view: 'mine', uid: 'oth' }).length, 3, 'mine by uid');
  eq(C.filterTickets(all, { view: 'active', q: 'od' }).map((t) => t.itemDescription), ['OD'], 'search');
  eq(C.filterTickets(all, { view: 'active', status: 'received' }).length, 1, 'status filter');
  od.urgency = 'urgent'; rc.urgency = 'needed_soon';
  eq(C.sortTickets(all, 'urgency').slice(0, 2).map((t) => t.itemDescription), ['OD', 'RC'], 'urgency sort');
  eq(C.sortTickets(all, 'status').map((t) => t.status), ['requested', 'needs_info', 'approved', 'ordered', 'received', 'placed'], 'stage sort');
}

console.log('── report + csv ──');
{
  const a = make({ itemDescription: 'A', reason: 'r', unitCost: 10, quantity: 2, fundingAccount: 'X', fundingLabel: 'Grant X', category: 'reagent' });
  const b = make({ itemDescription: 'B, "quoted"', reason: 'r', unitCost: 100, fundingAccount: 'X', category: 'equipment' }); b.status = 'received'; b.actualCost = 95;
  const c = make({ itemDescription: 'C', reason: 'r', unitCost: 7, fundingAccount: 'Y' }); c.status = 'denied';
  const d = make({ itemDescription: 'D', reason: 'r', unitCost: 5, fundingAccount: '', fundingLabel: '' }); d.status = 'ordered'; d.orderedCost = 6;
  const s = C.summarize([a, b, c, d], { from: '2026-01-01', to: '2026-12-31' });
  eq(s.totals, { committed: 26, spent: 95, count: 3, pending: 1 }, 'totals: denied excluded, ordered cost beats estimate, actual beats both');
  eq(s.byAccount.map((r) => r.account + ':' + r.committed + '/' + r.spent), ['X:20/95', '(no account):6/0'], 'by account');
  eq(C.summarize([a], { from: '2027-01-01', to: '2027-12-31' }).totals.count, 0, 'period filter');
  { const early = make({ itemDescription: 'E', reason: 'r', unitCost: 1 }); early.createdAt = new Date(Date.parse('2026-07-01T09:00:00'));
    const late = make({ itemDescription: 'L', reason: 'r', unitCost: 1 }); late.createdAt = new Date(Date.parse('2026-10-20T09:00:00'));
    eq(C.summarize([early, late], { from: '2026-07-01', to: '2026-10-19' }).totals.count, 1, 'period runs midnight to midnight, not noon to noon'); }
  ok(/^"?'=HYPERLINK/.test(C.toCSV([make({ itemDescription: '=HYPERLINK("x")', reason: 'r' })]).split('\r\n')[1].split(',')[2]), 'csv neutralises a formula cell');
  { const nc = make({ itemDescription: 'NC', reason: 'r', unitCost: 5 }); delete nc.createdAt;
    eq(C.summarize([nc], { from: '2026-01-01', to: '2026-12-31' }).totals.count, 0, 'a ticket with no createdAt is in no period');
    eq(C.summarize([nc], {}).totals.count, 1, '… but counts when no period is set'); }
  eq(C.fiscalYearStart(Date.parse('2026-10-19T12:00:00')), '2026-07-01', 'FY start July 1 (fall)');
  eq(C.fiscalYearStart(Date.parse('2026-03-19T12:00:00')), '2025-07-01', 'FY start July 1 (spring)');
  const csv = C.toCSV([b]);
  ok(csv.split('\r\n').length === 2 && /"B, ""quoted"""/.test(csv) && /^id,status,item/.test(csv), 'csv escapes quotes and commas');
}

console.log('── inventory hand-off ──');
{
  const t = make({ itemDescription: 'Tips', reason: 'r', vendor: 'Rainin', catalogueNumber: 'RT-1', productUrl: 'https://x', unitCost: 20, quantity: 2, category: 'consumable', fundingAccount: '1101935' });
  t.status = 'received'; t.actualCost = 50; t.quantityReceived = 2; t.orderDate = '2026-10-10'; t.receivedAt = new Date(NOW);
  const inv = C.newInventoryItem(t, { location: 'Bench 4', category: '' }, student, STAMP);
  eq([inv.kind, inv.name, inv.quantity, inv.unit_price, inv.extended_price, inv.category, inv.locations[0].quantity, inv.procurementTicketId, inv.reorder.url, inv.reorder.lead_time_days, inv.account_number],
     ['item', 'Tips', 2, 25, 50, 'consumable', 2, t.id, 'https://x', 9, '1101935'], 'new inventory item from the ticket');
  eq(inv.price_history[0].unit_price, 25, 'price history uses unit_price (the key inventory.js reads)');
  const item = { id: 'INV1', name: 'Tips', quantity: 3, locations: [{ name: 'bench 4', quantity: 3, notes: '' }], qty_tracked: true, qty_remaining: 100, qty_made: 300, price_history: [] };
  const p1 = C.restockPlan(item, t, { location: 'Bench 4', quantity: 2, unitPrice: 25 }, student, STAMP);
  eq([p1.patch.quantity, p1.patch.locations.length, p1.patch.locations[0].quantity, p1.ledgerRaised, p1.usage, p1.patch.qty_remaining], [5, 1, 5, false, null, undefined], 'member restock: merge location (case-insensitive), bump quantity, never touch the ledger');
  eq([p1.patch.price_history.length, p1.patch.price_history[0].unit_price], [1, 25], 'price history appended with unit_price');
  const p2 = C.restockPlan(item, t, { location: 'Freezer B', quantity: 2, unitPrice: 25 }, mgr, STAMP);
  eq([p2.patch.qty_remaining, p2.patch.qty_made, p2.usage.event, p2.usage.before, p2.usage.after, p2.usage.delta, p2.patch.locations.length], [102, 302, 'add', 100, 102, 2, 2], 'manager restock raises the ledger with an add row');
  const pre = C.prefillFromInventory({ id: 'INV1', name: 'Tips', vendor: 'Rainin', catalogue_number: 'RT-1', unit_price: 20, category: 'research_reagents', reorder: { url: 'https://x', last_price: 22 } });
  eq([pre.itemDescription, pre.unitCost, pre.category, pre.inventoryItemId, pre.productUrl], ['Tips', 22, 'reagent', 'INV1', 'https://x'], 'reorder prefill');
  eq(C.searchInventory([{ name: 'PEG 6000', vendor: 'Sigma' }, { name: 'Tips', catalogue_number: 'RT-1' }, { name: 'x', kind: 'stock' }], 'rt-1').map((i) => i.name), ['Tips'], 'inventory search by cat#');
  const t0 = Object.assign({}, t, { quantityReceived: 0 });
  ok(/Nothing was received/.test(C.placeQty(t0, {}).error), 'received 0 → cannot put away (falls back to undo received, not to the ordered qty)');
  eq(C.placeQty(t, { quantity: '-4' }).field, 'quantity', 'negative put-away qty refused');
  eq(C.placePrice(t, { unitPrice: '-10' }).field, 'unitPrice', 'negative price refused');
  eq(C.placePrice({ actualCost: 20, quantityReceived: 2, quantity: 5 }, {}).price, 10, 'unit price = actual cost ÷ quantity RECEIVED');
  const rb = C.restockPlan({ id: 'I', qty_tracked: true, quantity: 1, locations: [] }, t, { location: 'x', quantity: 1 }, student, STAMP);
  ok(rb.ledgerBlocked === true, 'a member restocking a tracked item with no count is flagged (rules would refuse it)');
}

console.log('── funded projects → funding strings ──');
{
  eq(OPTS.map((o) => o.id + '=' + o.funding_string), ['mcghee-startup=1101935', 'prostate=1101917-MCMI'], 'active projects only; funding_string beats account_number');
  eq(OPTS[1].label, 'Cancer Engineering - Prostate · 1101917-MCMI', 'label = name · funding string');
  eq(C.fundedProjectOptions([], [{ id: '3062920', label: 'ONR (3062920)' }]).map((o) => o.name + '=' + o.funding_string), ['ONR=3062920'], 'legacy fundingSources stand in when nothing is published');
  const v = C.applyProject({ projectOther: '' }, OPTS, 'prostate');
  eq([v.projectId, v.project, v.fundingAccount, v.fundingLabel], ['prostate', 'Cancer Engineering - Prostate', '1101917-MCMI', 'Cancer Engineering - Prostate · 1101917-MCMI'], 'choosing a project stamps name + funding string');
  const o = C.applyProject({ projectOther: 'Side thing' }, OPTS, '__other');
  eq([o.projectId, o.project, o.fundingAccount], ['__other', 'Side thing', ''], 'Other… keeps the typed name and no funding string');
  eq(C.projectForAccount(OPTS, '1101917-MCMI').id, 'prostate', 'reverse lookup by funding string (reorder prefill)');
  const other = make({ itemDescription: 'Side', reason: 'r', projectId: '__other', project: 'Side thing', fundingAccount: '', fundingLabel: '' });
  eq(other.projectId + '|' + other.fundingAccount, '|', 'Other… stores no projectId and no funding string');
  eq(C.buildPatch('approve', other, {}, approver, NOW, STAMP).field, 'projectId', 'approving without a funding string is refused');
  const ap = C.buildPatch('approve', other, C.applyProject({}, OPTS, 'mcghee-startup'), approver, NOW, STAMP);
  eq([ap.to, ap.patch.projectId, ap.patch.fundingAccount, ap.patch.project], ['approved', 'mcghee-startup', '1101935', 'McGhee Startup'], 'approver assigns the project at approval');
  const inv = C.newInventoryItem(Object.assign({}, other, { projectId: 'mcghee-startup', fundingAccount: '1101935', status: 'received' }), { location: 'x' }, student, STAMP);
  eq([inv.account_number, inv.project_tag], ['1101935', 'mcghee-startup'], 'inventory item carries account + project tag');
  const sm = C.summarize([make({ itemDescription: 'a', reason: 'r', unitCost: 10, project: 'P1' }), make({ itemDescription: 'b', reason: 'r', unitCost: 5, project: 'P2' })], {});
  eq(sm.byProject.map((r) => r.project + ':' + r.committed), ['P1:10', 'P2:5'], 'report by project');
}

console.log('── options + legacy ──');
{
  const f = C.fundingOptions([{ id: 'onr', title: 'ONR', account_number: '3062920', status: 'active' }, { id: 'old', title: 'Old', status: 'closed' }],
                             [{ id: 'startup', label: 'Startup', account_number: '1101935' }, { id: 'dup', account_number: '3062920' }],
                             [{ id: '1101935', label: 'Startup (1101935)' }, { id: 'x', label: 'Gift' }], [{ fundingAccount: 'y', fundingLabel: 'Prior' }]);
  eq(f.map((o) => o.id), ['3062920', '1101935', 'x', 'y'], 'funding: active awards, accounts, config sources, prior values, deduped');
  eq(C.projectOptions([{ title: 'MEBP paper' }, { title: 'Done', status: 'published' }], [{ project: 'mebp paper' }, { project: 'GELS' }]), ['MEBP paper', 'GELS'], 'projects deduped case-insensitively');
  eq(C.locationOptions([{ name: 'Box 4' }], [{ location: 'Shelf 3' }], [{ locations: [{ name: 'box 4' }, { name: 'Freezer A' }] }]), ['Shelf 3', 'Box 4', 'Freezer A'], 'locations');
  const legacy = { id: 'L', itemDescription: 'Old', status: 'placed', createdAt: { seconds: 1760000000 }, requesterName: 'Sam', approvedAt: { seconds: 1760100000 }, approvedByName: 'PI', piNotes: 'ok', orderDate: '2025-10-11', poNumber: 'P1', receivedAt: { seconds: 1760300000 }, placedAt: { seconds: 1760400000 }, location: 'Shelf' };
  eq(C.timelineOf(legacy).map((h) => h.action), ['submit', 'approve', 'order', 'receive', 'place'], 'legacy ticket gets a synthesized timeline');
  ok(C.timelineOf(legacy).every((h) => h.synthesized), 'marked synthesized');
  eq(C.isActive({ status: undefined }), true, 'missing status counts as requested/active');
}

console.log('── sweeps ──');
{
  const now = NOW;
  const o1 = { status: 'ordered', expectedDelivery: '2026-10-10' }, o2 = { status: 'ordered', expectedDelivery: '2026-10-18' }, o3 = { status: 'ordered' };
  eq(C.overdueOrders([o1, o2, o3], now).length, 1, 'overdue = past ETA + 2 days');
  eq(C.staleRequests([{ status: 'requested', createdAt: now - 6 * 86400000 }, { status: 'requested', createdAt: now - 1 * 86400000 }], now).length, 1, 'stale > 5 days');
  eq(C.staleRequests([{ status: 'requested', createdAt: now - 20 * 86400000, lastActivityAt: new Date(now - 86400000).toISOString() }], now).length, 0, 'an answer/reopen restarts the stale clock');
  eq(C.orderGroupSiblings([{ id: 'a', orderGroupId: 'G', status: 'ordered' }, { id: 'b', orderGroupId: 'G', status: 'ordered' }, { id: 'c', orderGroupId: 'G', status: 'received' }], { id: 'a', orderGroupId: 'G' }).map((x) => x.id), ['b'], 'PO siblings = same group, still ordered');
  eq(C.unplacedArrivals([{ status: 'received', receivedAt: now - 4 * 86400000 }, { status: 'received', receivedAt: now }], now).length, 1, 'unplaced > 3 days');
}

console.log('── V3.814: purchase type + price comparison ──');
{
  const t = make({ itemDescription: 'Tips', reason: 'r', vendor: 'VWR', purchaseType: 'recurring', recurrence: 'monthly',
    comparisons: [{ vendor: 'Fisher', unitPrice: '$12.50', url: 'https://fisher.com/x', catalogueNumber: 'F-1' }, {}, { vendor: 'vwr', unitPrice: '11', notes: 'pack of 10' }, { vendor: '', unitPrice: '', url: '' }] });
  eq([t.purchaseType, t.recurrence, t.comparisons.length], ['recurring', 'monthly', 2], 'purchase type + recurrence stored; empty comparison rows dropped');
  eq([t.comparisons[0].unitPrice, t.comparisons[0].chosen, t.comparisons[1].chosen], [12.5, false, true], '"$12.50" → 12.5; the row matching the main vendor is marked chosen');
  eq(make({ itemDescription: 'x', reason: 'r', purchaseType: 'one_time', recurrence: 'monthly' }).recurrence, '', 'recurrence only with recurring');
  eq(C.validateRequest({ itemDescription: 'x', reason: 'r', project: 'P', purchaseType: 'nope' }).field, 'purchaseType', 'an unknown purchase type is not a purchase type');
  eq(C.validateRequest({ itemDescription: 'x', reason: 'r', project: 'P', purchaseType: 'one_time', comparisons: [{ vendor: 'A', unitPrice: 'ten dollars' }] }).field, 'comparisons', 'a comparison price must be a number');
  eq(C.validateRequest({ itemDescription: 'x', reason: 'r', project: 'P', purchaseType: 'one_time', comparisons: [{ vendor: 'A', unitPrice: '-1' }] }).row, 0, '… and the error names the row');
  eq(C.validateRequest({ itemDescription: 'x', reason: 'r', project: 'P', purchaseType: 'one_time', comparisons: [{ vendor: 'A' }, { unitPrice: '5' }] }).error, 'Source 2 needs a vendor name.', 'a priced row with no vendor is refused');
  eq(C.validateRequest({ itemDescription: 'x', reason: 'r', project: 'P', purchaseType: 'one_time', comparisons: [{ vendor: 'A', url: 'fisher.com' }] }).field, 'comparisons', 'a comparison link must be http(s)');
  eq(C.cleanComparisons(Array.from({ length: 9 }, (_, i) => ({ vendor: 'V' + i }))).length, C.MAX_COMPARISONS, 'capped at MAX_COMPARISONS');
  // Use this one
  const v = { vendor: '', unitCost: '', quantity: 2, comparisons: [{ vendor: 'Fisher', unitPrice: '$12.50', url: 'https://fisher.com/x', catalogueNumber: 'F-1' }, { vendor: '' }, { vendor: 'VWR', unitPrice: 11 }] };
  C.applyComparison(v, 2);
  eq([v.vendor, v.unitCost, v.comparisons[2].chosen, v.comparisons[0].chosen], ['VWR', 11, true, false], 'Use copies vendor + price into the main fields (index as typed, empty rows included)');
  C.applyComparison(v, 0);
  eq([v.vendor, v.unitCost, v.catalogueNumber, v.productUrl, v.comparisons[0].chosen, v.comparisons[2].chosen], ['Fisher', 12.5, 'F-1', 'https://fisher.com/x', true, false], 'Use on another row moves the choice');
  eq(C.applyComparison({ comparisons: [{ vendor: '' }] }, 0).vendor, undefined, 'Use on a row with no vendor does nothing');
  // edit detects comparison changes
  const e1 = C.buildPatch('edit', t, Object.assign(C.cleanRequest(t), { comparisons: t.comparisons.slice(0, 1) }), student, NOW, STAMP);
  ok(/Changed price comparison/.test(e1.appends.history[0].note) && e1.patch.comparisons.length === 1, 'editing the comparison is a change: ' + e1.appends.history[0].note);
  eq(C.buildPatch('edit', t, C.cleanRequest(t), student, NOW, STAMP).error, 'Nothing changed.', 'an untouched comparison is not a change');
  // a pre-V3.814 ticket (no purchaseType) can still be edited without choosing one
  const legacy = make({ itemDescription: 'Old', reason: 'r' }); delete legacy.purchaseType; delete legacy.comparisons;
  const le = C.buildPatch('edit', legacy, Object.assign(C.cleanRequest(legacy), { vendor: 'New vendor' }), student, NOW, STAMP);
  ok(!le.error && le.patch.vendor === 'New vendor' && !('comparisons' in le.patch), 'legacy ticket edits without a purchase type, and [] vs missing comparisons is not a change');
  eq(C.buildPatch('edit', legacy, Object.assign(C.cleanRequest(legacy), { vendor: 'New vendor', purchaseType: 'nope' }), student, NOW, STAMP).error, undefined, 'a junk purchase type on a legacy edit is just dropped (still legacy)');
  eq(C.buildPatch('edit', legacy, Object.assign(C.cleanRequest(legacy), { purchaseType: 'recurring', recurrence: 'monthly' }), student, NOW, STAMP).patch.purchaseType, 'recurring', 'a legacy ticket can be given a purchase type by editing');
  // CSV + search
  const csv = C.toCSV([t]).split('\r\n');
  ok(/,purchase_type,recurrence,sources_compared,/.test(csv[0]) && /,recurring,monthly,2,/.test(csv[1]), 'csv carries purchase type, recurrence, sources compared');
  eq(C.filterTickets([t, make({ itemDescription: 'Other', reason: 'r' })], { q: 'fisher' }).length, 1, 'search matches a comparison vendor');
  eq(C.filterTickets([t, make({ itemDescription: 'Other', reason: 'r' })], { q: 'recurring' }).length, 1, 'search matches "recurring"');
}

console.log('── V3.814: AI prompt + import ──');
{
  const p = C.aiPrompt({ itemDescription: 'PEG 6000, 100 g', vendor: 'Sigma', catalogueNumber: '81260', quantity: 2, reason: 'gels', category: 'reagent' }, { lab: 'the McGhee Lab', today: '2026-10-19' });
  ok(/ITEM: PEG 6000, 100 g/.test(p) && /KNOWN SOURCE: Sigma, cat# 81260/.test(p) && /QUANTITY NEEDED: 2/.test(p) && /WHY WE NEED IT: gels/.test(p) && /CATEGORY: Reagent \/ kit/.test(p), 'prompt carries what was typed');
  ok(/ONLY this JSON/.test(p) && /"sources"/.test(p) && /"recommended"/.test(p) && /"purchaseType"/.test(p) && /2026-10-19/.test(p), 'prompt demands the JSON schema and dates itself');
  ok(/\(not given — ask for it\)/.test(C.aiPrompt({}, {})), 'empty form still yields a usable prompt');
  const good = 'Here you go:\n```json\n{"item":"PEG","sources":[{"vendor":"Fisher","catalogueNumber":"F1","url":"https://fisher.com/p","unitPrice":"$45.00","packSize":"100 g","leadTime":"3 days"},{"vendor":"Sigma","unitPrice":39.5,"url":"sigma.com/x","notes":"list price"},{"vendor":"","unitPrice":1}],"recommended":7,"whyRecommended":"cheapest","purchaseType":"Recurring","recurrence":"monthly",}\n```\nLet me know!';
  const r = C.parseAiResults(good);
  ok(!r.error, 'fenced JSON with prose around it, a trailing comma and a $ price parses: ' + r.error);
  eq(r.results.sources.map((s) => s.vendor + ':' + s.unitPrice + ':' + s.chosen), ['Fisher:45:false', 'Sigma:39.5:true'], 'rows without a vendor dropped; out-of-range recommendation → cheapest priced row');
  eq([r.results.sources[1].url, /link given: sigma\.com/.test(r.results.sources[1].notes)], ['', true], 'a non-http link is moved into notes, not stored as a link');
  eq([r.results.purchaseType, r.results.recurrence, r.results.whyRecommended], ['recurring', 'monthly', 'cheapest'], 'purchase type normalised');
  eq(C.parseAiResults('{"sources":[{"vendor":"A","unitPrice":5},{"vendor":"B","unitPrice":3}],"recommended":0}').results.recommended, 0, 'an in-range recommendation is kept even when not the cheapest');
  ok(/Paste the AI/.test(C.parseAiResults('   ').error), 'empty paste');
  ok(/JSON block/.test(C.parseAiResults('Sorry, I cannot browse.').error), 'prose only');
  ok(/would not parse/.test(C.parseAiResults('{"sources": [ {vendor: A} ]}').error), 'broken JSON says so');
  ok(/No sources/.test(C.parseAiResults('{"sources":[]}').error) && /No sources/.test(C.parseAiResults('{"sources":[{"unitPrice":3}]}').error), 'no usable rows');
  ok(/JSON block|JSON object/.test(C.parseAiResults('[1,2]').error), 'a bare array is refused');
  eq(C.parseAiResults('{"options":[{"supplier":"VWR","price":"12 USD","link":"https://vwr.com/a","sku":"V-1"}]}').results.sources[0], { vendor: 'VWR', catalogueNumber: 'V-1', url: 'https://vwr.com/a', unitPrice: 12, packSize: '', leadTime: '', notes: '', chosen: true }, 'tolerates synonym keys (options/supplier/price/link/sku)');
  // apply: typed wins, empty fills
  const v1 = { itemDescription: 'PEG', vendor: '', unitCost: '', purchaseType: '', comparisons: [] };
  const took1 = C.applyAiResults(v1, r.results);
  eq([took1.sources, took1.main, took1.purchaseType, v1.vendor, v1.unitCost, v1.purchaseType, v1.recurrence, v1.comparisons.length, v1._aiWhy], [2, true, true, 'Sigma', 39.5, 'recurring', 'monthly', 2, 'cheapest'], 'empty form takes the recommended source + the purchase-type guess');
  const v2 = { itemDescription: 'PEG', vendor: 'My vendor', unitCost: 99, purchaseType: 'one_time', comparisons: [] };
  const took2 = C.applyAiResults(v2, r.results);
  eq([took2.main, took2.purchaseType, v2.vendor, v2.unitCost, v2.purchaseType, v2.comparisons.length], [false, false, 'My vendor', 99, 'one_time', 2], 'what the person typed wins; the comparison still fills');
  eq(C.applyAiResults({}, { sources: [] }).sources, 0, 'nothing to apply');
}

console.log('── V3.814: change funding (reassign) ──');
{
  const t = make({ itemDescription: 'PEG', reason: 'r', projectId: 'mcghee-startup', project: 'McGhee Startup', fundingAccount: '1101935', fundingLabel: 'McGhee Startup · 1101935' });
  ok(!C.can('reassign', t, student) && !C.can('reassign', t, buyer) && C.can('reassign', t, approver) && C.can('reassign', t, admin), 'only approvers (and admins) may change funding');
  ['requested', 'needs_info', 'approved', 'ordered', 'received', 'placed'].forEach((s) => { t.status = s; ok(C.can('reassign', t, approver), 'reassign allowed while ' + s); });
  ['denied', 'cancelled'].forEach((s) => { t.status = s; ok(!C.can('reassign', t, approver), 'reassign not offered on ' + s); });
  t.status = 'ordered';
  eq(C.availableActions(t, approver), ['receive', 'flag', 'reassign', 'note'], 'approver sees Change funding on an ordered ticket');
  eq(C.buildPatch('reassign', t, { projectId: 'mcghee-startup', project: 'McGhee Startup', fundingAccount: '1101935', fundingLabel: 'McGhee Startup · 1101935' }, approver, NOW, STAMP).error, 'That is already the project on this ticket.', 'same project refused');
  eq(C.buildPatch('reassign', t, { projectId: '', project: '' }, approver, NOW, STAMP).field, 'projectId', 'no project refused');
  eq(C.buildPatch('reassign', t, C.applyProject({ projectOther: 'Side thing' }, OPTS, '__other'), approver, NOW, STAMP).error, 'Pick a funded project — an approved ticket must carry a funding string.', 'past approval, "Other" (no funding string) is refused');
  const r = C.buildPatch('reassign', t, Object.assign(C.applyProject({}, OPTS, 'prostate'), { note: 'startup is closing' }), approver, NOW, STAMP);
  eq([r.to, r.patch.status, r.patch.projectId, r.patch.project, r.patch.fundingAccount, r.patch.fundingLabel, r.patch.fundingChangedBy, r.patch.fundingChangedFrom], ['ordered', undefined, 'prostate', 'Cancer Engineering - Prostate', '1101917-MCMI', 'Cancer Engineering - Prostate · 1101917-MCMI', 'app', 'McGhee Startup · 1101935'], 'reassign patch: same status, new project + funding string, who/from stamped');
  ok(Object.keys(r.patch).every((k) => C.NOTE_ONLY_KEYS.indexOf(k) >= 0 || C.FUNDING_KEYS.indexOf(k) >= 0), 'reassign touches only NOTE_ONLY_KEYS + FUNDING_KEYS (what the rules allow past approval): ' + Object.keys(r.patch));
  eq(r.appends.history[0].action, 'reassign', 'history action');
  ok(/Now charged to Cancer Engineering - Prostate · 1101917-MCMI \(was McGhee Startup · 1101935\) — startup is closing/.test(r.appends.history[0].note), 'history says from → to and why: ' + r.appends.history[0].note);
  eq([r.appends.notes[0].kind, r.appends.notes[0].text === r.appends.history[0].note], ['funding', true], 'the same line lands in the notes thread as a funding note');
  apply(t, r);
  eq([t.fundingAccount, t.fundingChangedFrom, t.status], ['1101917-MCMI', 'McGhee Startup · 1101935', 'ordered'], 'applied');
  const t2 = make({ itemDescription: 'Side', reason: 'r', projectId: '__other', project: 'Side thing', fundingAccount: '', fundingLabel: '' });
  const r2 = C.buildPatch('reassign', t2, C.applyProject({ projectOther: 'Other side' }, OPTS, '__other'), approver, NOW, STAMP);
  ok(!r2.error && r2.patch.project === 'Other side' && /\(no funding string yet\) \(was Side thing\)/.test(r2.appends.history[0].note), 'while still requested, Other → another Other is fine (no funding string yet): ' + r2.appends.history[0].note);
}

console.log('── V3.814: request again + inventory memory ──');
{
  const t = make({ itemDescription: 'Tips', reason: 'daily', vendor: 'VWR', catalogueNumber: 'V-1', productUrl: 'https://vwr.com/v1', unitCost: 11, quantity: 3, category: 'consumable', urgency: 'urgent', neededBy: '2026-11-01', projectId: 'prostate', project: 'Cancer Engineering - Prostate', fundingAccount: '1101917-MCMI', fundingLabel: 'P · 1101917-MCMI', purchaseType: 'recurring', recurrence: 'monthly', comparisons: [{ vendor: 'Fisher', unitPrice: 12 }, { vendor: 'VWR', unitPrice: 11 }] });
  t.status = 'placed'; t.inventoryItemId = 'INV7';
  const pre = C.prefillFromTicket(t);
  eq([pre.itemDescription, pre.vendor, pre.catalogueNumber, pre.productUrl, pre.unitCost, pre.quantity, pre.category, pre.projectId, pre.fundingAccount, pre.purchaseType, pre.recurrence, pre.comparisons.length, pre.comparisons[1].chosen, pre.reason, pre.neededBy, pre.urgency, pre.inventoryItemId, pre.repeatOf],
     ['Tips', 'VWR', 'V-1', 'https://vwr.com/v1', 11, 3, 'consumable', 'prostate', '1101917-MCMI', 'recurring', 'monthly', 2, true, 'daily', '', 'routine', 'INV7', t.id], 'Request again: everything copied, dates/urgency reset, inventory link + provenance kept');
  const legacy = make({ itemDescription: 'Old', reason: 'r' }); delete legacy.purchaseType;
  eq([C.prefillFromTicket(legacy).purchaseType, C.prefillFromTicket(legacy).recurrence], ['recurring', 'unsure'], 'a repeat of a pre-V3.814 ticket is marked recurring');
  const again = C.buildCreate(pre, student, NOW, STAMP, { inventoryItemId: pre.inventoryItemId, source: 'repeat', repeatOf: pre.repeatOf });
  eq([again.data.repeatOf, again.data.inventoryItemId, again.data.source, again.data.status], [t.id, 'INV7', 'repeat', 'requested'], 'the repeat ticket carries repeatOf + the restock target');
  // the inventory item remembers the sources for next time
  t.status = 'received'; t.actualCost = 33; t.quantityReceived = 3; t.receivedAt = new Date(NOW);
  const inv = C.newInventoryItem(t, { location: 'Bench 4' }, student, STAMP);
  eq([inv.reorder.recurring, inv.reorder.alternatives.length, inv.reorder.alternatives[1].chosen], [true, 2, true], 'new inventory item stores recurring + the comparison as reorder.alternatives');
  const plan = C.restockPlan({ id: 'INV7', quantity: 1, locations: [], reorder: { url: 'https://old' } }, t, { location: 'Bench 4', quantity: 3, unitPrice: 11 }, student, STAMP);
  eq([plan.patch.reorder.alternatives.length, plan.patch.reorder.recurring, plan.patch.reorder.url], [2, true, 'https://vwr.com/v1'], 'restock teaches the item the alternatives too');
  const back = C.prefillFromInventory({ id: 'INV7', name: 'Tips', vendor: 'VWR', unit_price: 11, category: 'consumable', reorder: { url: 'https://vwr.com/v1', last_price: 11, recurring: true, alternatives: inv.reorder.alternatives } });
  eq([back.purchaseType, back.recurrence, back.comparisons.length, back.comparisons[1].chosen], ['recurring', 'unsure', 2, true], 'Request reorder from inventory brings the comparison back');
  const plain = C.restockPlan({ id: 'I', quantity: 1, locations: [] }, make({ itemDescription: 'x', reason: 'r' }), { location: 'x', quantity: 1 }, student, STAMP);
  ok(!('alternatives' in plain.patch.reorder) && !('recurring' in plain.patch.reorder), 'a ticket without a comparison leaves reorder memory alone');
}

console.log('── V3.819: browser-extension capture → New item ──');
{
  const cap = { id: 'cap1', name: ' ELISA plates, 96-well ', vendor: 'Corning', catalogueNumber: '3590', url: 'https://www.corning.com/p/3590', price: 18.75, priceText: '$18.75', packSize: '50/case', quantity: 3, note: 'for the ELISA', sourceHost: 'www.corning.com', capturedAtIso: '2026-10-21T15:00:00Z' };
  const v = C.prefillFromCapture(cap);
  eq([v.itemDescription, v.vendor, v.catalogueNumber, v.productUrl, v.unitCost, v.quantity, v.reason, v.purchaseType, v.captureId, v.comparisons.length], ['ELISA plates, 96-well', 'Corning', '3590', 'https://www.corning.com/p/3590', 18.75, 3, 'for the ELISA', '', 'cap1', 1], 'capture → composer values (purchase type left for the person)');
  eq([v.comparisons[0].vendor, v.comparisons[0].unitPrice, v.comparisons[0].packSize, v.comparisons[0].chosen, v.comparisons[0].notes], ['Corning', 18.75, '50/case', true, 'captured from corning.com on 2026-10-21'], 'the capture is the first, chosen comparison row');
  const v2 = C.prefillFromCapture({ id: 'c', name: 'Tape', priceText: 'USD 4.50', url: 'javascript:alert(1)', quantity: '0' });
  eq([v2.unitCost, v2.productUrl, v2.quantity, v2.comparisons.length, v2.vendor], [4.5, '', 1, 0, ''], 'price parsed from text, an unsafe link dropped, zero qty → 1, no vendor → no comparison row');
  eq(C.prefillFromCapture({ id: 'c', name: 'Quote only', priceText: 'Request a quote', vendor: 'V' }).unitCost, '', 'no parsable price → empty unit cost');
  const r = C.buildCreate(Object.assign({}, v, { projectId: 'prostate', project: 'P', fundingAccount: '1101917-MCMI', purchaseType: 'one_time' }), student, NOW, STAMP, { source: 'extension', captureId: v.captureId });
  eq([r.data.source, r.data.captureId, r.data.status, r.data.comparisons[0].chosen, r.data.estimatedCost], ['extension', 'cap1', 'requested', true, 56.25], 'the ticket from a capture is an ordinary requested ticket with its provenance');
  eq(C.buildCreate({ itemDescription: 'x', reason: 'r', project: 'P', purchaseType: 'one_time' }, student, NOW, STAMP).data.captureId, null, 'no capture → null');
}

console.log('── V3.820: price watch ──');
{
  eq(C.normalizeProductUrl('https://www.vwr.com/us/en/product/37358545/centrifuge-tubes-50-ml/?utm_source=x#top'), 'vwr.com/us/en/product/37358545/centrifuge-tubes-50-ml', 'url normalised: www, slash, tracking, hash dropped');
  eq(C.normalizeProductUrl('https://www.amazon.com/Kimberly/dp/B000ABCDEF/ref=sr_1?th=1'), 'amazon.com/dp/B000ABCDEF', 'Amazon → ASIN');
  eq([C.watchIdFor('javascript:alert(1)'), C.watchIdFor('')], ['', ''], 'unwatchable → empty id');
  ok(/^vwr-com-[0-9a-f]{16}$/.test(C.watchIdFor('https://www.vwr.com/us/en/product/37358545/x')), 'watch id = host slug + 16 hex');
  eq(C.watchIdFor('https://www.vwr.com/us/en/product/37358545/x/'), C.watchIdFor('http://vwr.com/us/en/product/37358545/x?utm=1'), 'one page, one id');
  const obs = C.priceObservationsFrom({ itemDescription: 'Tubes', vendor: 'VWR', catalogueNumber: '76520-944', productUrl: 'https://www.vwr.com/p/1', unitCost: '246.57',
    comparisons: [{ vendor: 'Fisher', url: 'https://www.fishersci.com/p/2', unitPrice: '$250.00' }, { vendor: 'VWR', url: 'https://vwr.com/p/1/', unitPrice: 240 }, { vendor: 'No link', unitPrice: 5 }, { vendor: 'No price', url: 'https://x.com/p' }] }, 'T1');
  eq(obs.map((o) => o.url + ':' + o.price + ':' + o.vendor), ['https://www.vwr.com/p/1:246.57:VWR', 'https://www.fishersci.com/p/2:250:Fisher'], 'the link + unit cost and each priced, linked comparison row; the same page is not counted twice; rows without a link or price skipped');
  eq([obs[0].method, obs[0].ticketId, obs[0].id === C.watchIdFor('https://www.vwr.com/p/1'), obs[0].name], ['request', 'T1', true, 'Tubes'], 'observation shape');
  eq(C.priceObservationsFrom({ productUrl: 'https://a.com/p', unitCost: 0 }).length, 0, 'no price → no observation');
  const w = C.newWatchDoc(obs[0], '2026-10-22T12:00:00.000Z', 'stu');
  eq([w.normUrl, w.host, w.latest.price, w.history.length, w.nextCheckAt, w.status, w.createdBy, w.lastActorUid, w.ticketIds, w.checkEveryDays], ['vwr.com/p/1', 'vwr.com', 246.57, 1, '2027-01-20T12:00:00.000Z', 'active', 'stu', 'stu', ['T1'], 90], 'a new watch: due in 90 days, created by the requester');
  const watches = [Object.assign({ id: w.id = obs[0].id }, w, { history: [w.latest, { at: '2027-01-21T00:00:00Z', price: 260, method: 'rescrape', by: 'ext' }], latest: { at: '2027-01-21T00:00:00Z', price: 260, method: 'rescrape', by: 'ext' } })];
  eq(C.watchSummary(C.watchFor(watches, 'https://vwr.com/p/1/?utm=2')), { id: obs[0].id, price: 260, at: '2027-01-21T00:00:00Z', method: 'rescrape', checks: 2, status: 'active', nextCheckAt: '2027-01-20T12:00:00.000Z', url: 'https://www.vwr.com/p/1' }, 'lookup by any dressing of the URL → the latest price and the count');
  eq(C.watchFor(watches, 'https://other.com/p'), null, 'no watch → null');
  const cat = C.catalogue([{ id: 'I1', kind: 'item', name: 'Tubes', vendor: 'VWR', reorder: { url: 'https://www.vwr.com/p/1', last_price: 240 } }], [], watches);
  eq([cat[0].lastPrice, cat[0].watchPrice, cat[0].watchAt, cat[0].watchChecks, cat[0].watchId], [240, 260, '2027-01-21T00:00:00Z', 2, obs[0].id], 'catalogue rows carry the watched list price beside the last paid price');
  ok(!('watchPrice' in C.catalogue([{ id: 'I1', kind: 'item', name: 'Tubes', reorder: { url: 'https://www.vwr.com/p/1' } }], [])[0]), 'no watches passed → no watch fields');
}

console.log('── V3.816: reorder catalogue ──');
{
  const items = [
    { id: 'INV1', kind: 'item', name: 'Pipette tips 200 µL', vendor: 'Sigma', catalogue_number: 'T-200', quantity: 10, unit_price: 70, qty_tracked: true, qty_remaining: 4, qty_min: 5, qty_unit: 'ea', locations: [{ name: 'Bench 4' }], reorder: { url: 'https://sigma/t200', last_price: 75, recurring: true, alternatives: [{ vendor: 'Fisher', unitPrice: 80 }] }, category: 'consumable', procurementTicketId: 'T0', date_acquired: '2026-09-01' },
    { id: 'INV2', kind: 'item', name: 'Nitrile gloves M', vendor: 'Fisher', quantity: 3, locations: [], category: 'consumable', stock_status: 'out_of_stock' },
    { id: 'INV3', kind: 'item', name: 'Centrifuge', vendor: 'Beckman', category: 'equipment', quantity: 1, locations: [{ name: 'Room 312' }, { name: 'Bench 4' }] },
    { id: 'INV4', kind: 'item', name: 'Mystery', quantity: 1 },
    { id: 'BOX', kind: 'box', name: 'Freezer A' },
  ];
  const tickets = [
    { id: 'T0', status: 'placed', inventoryItemId: 'INV1', itemDescription: 'Pipette tips', vendor: 'Sigma', createdAt: '2026-09-01', unitCost: 70, quantity: 1 },
    { id: 'T1', status: 'placed', inventoryItemId: 'INV1', itemDescription: 'Pipette tips 200 µL', vendor: 'Sigma', createdAt: '2026-10-01', actualCost: 160, quantityReceived: 2, quantity: 2, purchaseType: 'recurring' },
    { id: 'T2', status: 'ordered', itemDescription: 'PEG 6000', vendor: 'Sigma-Aldrich', catalogueNumber: '81260', createdAt: '2026-10-10', unitCost: 50, quantity: 2, category: 'reagent', project: 'ONR', comparisons: [{ vendor: 'a' }, { vendor: 'b' }] },
    { id: 'T3', status: 'approved', itemDescription: 'peg 6000', vendor: 'sigma aldrich', catalogueNumber: '81260', createdAt: '2026-10-15', unitCost: 55, quantity: 1, category: 'reagent', project: 'Startup', fundingAccount: '1101935' },
    { id: 'T4', status: 'requested', itemDescription: 'Not yet approved', vendor: 'X', createdAt: '2026-10-16' },
    { id: 'T5', status: 'denied', itemDescription: 'Denied thing', vendor: 'X', createdAt: '2026-10-16' },
    { id: 'T6', status: 'approved', itemDescription: 'nitrile gloves m', vendor: 'FISHER', createdAt: '2026-10-18', unitCost: 9, quantity: 1 },
  ];
  const cat = C.catalogue(items, tickets);
  eq(cat.map((e) => e.id), ['inv:INV3', 'inv:INV4', 'inv:INV2', 'tkt:sigma-aldrich-peg-6000-81260', 'inv:INV1'], 'inventory items (not boxes) + approved-ticket groups, sorted by name');
  const tips = cat.find((e) => e.id === 'inv:INV1'), peg = cat.find((e) => e.kind === 'ticket'), glv = cat.find((e) => e.id === 'inv:INV2');
  eq([tips.timesBought, C.fmtDate(tips.lastBought), tips.lastPrice, tips.stock, tips.recurring, tips.alternatives, tips.locations, tips.url], [2, '2026-10-01', 80, 'low', true, 1, ['Bench 4'], 'https://sigma/t200'], 'linked tickets fold into the item: creation ticket counted once, later price wins, tracked count vs minimum = low');
  eq([peg.name, peg.vendor, peg.timesBought, C.fmtDate(peg.lastBought), peg.lastPrice, peg.status, peg.ticketId, peg.project, peg.account, peg.alternatives, peg.categoryLabel], ['PEG 6000', 'Sigma-Aldrich', 2, '2026-10-15', 55, 'approved', 'T3', 'Startup', '1101935', 0, 'Reagents / kits'], 'unlinked tickets dedupe by vendor+name+cat# (case/punctuation-insensitive); the latest decides status, price, project');
  eq([glv.timesBought, glv.stock, glv.lastPrice], [1, 'out_of_stock', 9], 'an unlinked order for a stocked item folds into that item by vendor + name');
  ok(!cat.some((e) => /Not yet approved|Denied/.test(e.name)), 'requested / denied tickets are not "already approved"');
  eq(cat.find((e) => e.id === 'inv:INV4').categoryLabel, 'Uncategorised', 'no category → Uncategorised');
  eq([C.stockOf({ qty_tracked: true, qty_remaining: 0, qty_min: 2 }), C.stockOf({ qty_tracked: true, qty_remaining: 9, qty_min: 2 }), C.stockOf({ qty_tracked: true, qty_remaining: 3 }), C.stockOf({ stock_status: 'low' }), C.stockOf({ stock_status: 'weird' }), C.stockOf({})], ['out_of_stock', 'full', 'full', 'low', '', ''], 'stock: tracked count vs minimum, else stock_status, else unknown');
  const f = C.catalogueFacets(cat);
  eq(f.categories.map((c) => c.id + ':' + c.n), ['equipment:1', 'consumable:2', 'research_reagents:1', '~:1'], 'category facets in inventory order with counts, Uncategorised last (id ~, never the empty "all" value)');
  eq(C.filterCatalogue(cat, { category: '~' }).map((e) => e.name), ['Mystery'], 'the Uncategorised facet filters to items with no category');
  eq([f.vendors[0].label, f.vendors.length, f.low, f.inventory, f.tickets, f.total], ['Beckman', 4, 2, 4, 1, 5], 'vendor facets (by count then name), low/out count, source counts');
  eq(C.filterCatalogue(cat, { q: 'sigma' }).map((e) => e.name), ['PEG 6000', 'Pipette tips 200 µL'], 'search matches vendor');
  eq(C.filterCatalogue(cat, { q: 'bench 4 tips' }).map((e) => e.name), ['Pipette tips 200 µL'], 'every word must match (location + name)');
  eq(C.filterCatalogue(cat, { q: '81260' }).map((e) => e.name), ['PEG 6000'], 'search matches catalogue #');
  eq(C.filterCatalogue(cat, { q: 'startup' }).map((e) => e.name), ['PEG 6000'], 'search matches project');
  eq(C.filterCatalogue(cat, { category: 'consumable' }).map((e) => e.name), ['Nitrile gloves M', 'Pipette tips 200 µL'], 'category filter');
  eq(C.filterCatalogue(cat, { vendor: 'sigma aldrich' }).map((e) => e.name), ['PEG 6000'], 'vendor filter is punctuation-insensitive');
  eq(C.filterCatalogue(cat, { stock: 'low' }).map((e) => e.name), ['Nitrile gloves M', 'Pipette tips 200 µL'], 'low-or-out filter');
  eq(C.filterCatalogue(cat, { kind: 'ticket' }).map((e) => e.name), ['PEG 6000'], 'source filter: bought before, not in inventory');
  eq(C.filterCatalogue(cat, { sort: 'stock' }).map((e) => e.name), ['Nitrile gloves M', 'Pipette tips 200 µL', 'Centrifuge', 'Mystery', 'PEG 6000'], 'lowest stock first, then name');
  eq(C.filterCatalogue(cat, { sort: 'often' }).map((e) => e.name), ['PEG 6000', 'Pipette tips 200 µL', 'Nitrile gloves M', 'Centrifuge', 'Mystery'], 'most often bought, ties by most recent then name');
  eq(C.filterCatalogue(cat, { sort: 'recent' }).slice(0, 2).map((e) => e.name), ['Nitrile gloves M', 'PEG 6000'], 'recently bought first');
  eq(C.groupCatalogue(cat, 'category').map((g) => g.label + ':' + g.items.length), ['Equipment:1', 'Consumables:2', 'Reagents / kits:1', 'Uncategorised:1'], 'group by category in inventory order');
  eq(C.groupCatalogue(cat, 'vendor').map((g) => g.label), ['Beckman', 'Fisher', 'Sigma', 'Sigma-Aldrich', 'No vendor'], 'group by vendor, no-vendor last');
  eq(C.groupCatalogue(cat, 'location').map((g) => g.label + ':' + g.items.length), ['Bench 4:2', 'Room 312:1', 'No location recorded:2', 'Not in inventory:1'], 'group by location: an item in two places appears in both; unplaced and ticket-only last');
  eq(C.groupCatalogue(cat, 'none').map((g) => g.label + ':' + g.items.length), ['All items:5'], 'no grouping');
  eq(C.catalogue([], []).length, 0, 'empty catalogue');
  eq(C.groupCatalogue(C.filterCatalogue(cat, { q: 'zzz' }), 'category'), [], 'no matches → no groups');
}

console.log('── formatting ──');
eq(C.fmtMoney(1234.5), '$1,234.50', 'money');
eq(C.fmtMoney(''), '', 'money blank');
eq(C.toMs({ seconds: 10 }), 10000, 'timestamp → ms');
eq(C.fmtDate('2026-10-19'), '2026-10-19', 'date string round trip');
eq(C.ageLabel(NOW - 3 * 86400000, NOW), '3d ago', 'age label');

// ── V3.881 — receipts, requisitions and other order documents ──
console.log('── documents (V3.881) ──');
eq(C.DOC_KIND_IDS, ['receipt', 'requisition', 'invoice', 'packing_slip', 'po', 'quote', 'other'], 'doc kinds (the rules list the same seven)');
eq([C.docKindLabel('requisition'), C.docKindLabel('packing_slip'), C.docKindLabel('nope')], ['Requisition', 'Packing slip', 'Other'], 'kind labels; unknown is Other');
eq([C.docContentType('r.pdf', 'application/pdf'), C.docContentType('IMG_1.HEIC', ''), C.docContentType('scan.jpg', 'application/octet-stream'), C.docContentType('x.docx', ''), C.docContentType('photo', 'image/png')],
   ['application/pdf', 'image/heic', 'image/jpeg', '', 'image/png'], 'content type: the browser’s for a PDF / image, else from the extension (a phone HEIC often has none), else refused');
eq(C.checkDocFile({ name: 'r.pdf', type: 'application/pdf', size: 2048 }), { ok: true, contentType: 'application/pdf' }, 'a PDF passes');
ok(/not a PDF or a photo/.test(C.checkDocFile({ name: 'list.xlsx', type: '', size: 10 }).error), 'a spreadsheet is refused before upload');
ok(/over 20 MB/.test(C.checkDocFile({ name: 'big.pdf', type: 'application/pdf', size: 21 * 1024 * 1024 }).error), 'over 20 MB is refused (Storage would)');
ok(/empty/.test(C.checkDocFile({ name: 'e.pdf', type: 'application/pdf', size: 0 }).error), 'an empty file is refused');
eq([C.safeFileName('Fisher receipt #123 (Oct).pdf'), C.safeFileName('///'), C.docStoragePath('D1', 'a b.pdf')], ['Fisher_receipt_123_Oct_.pdf', 'file', 'procurement/docs/D1/a_b.pdf'], 'safe names and the docs path');

const T = [
  { id: 't1', status: 'ordered', poNumber: 'PO-77', orderGroupId: 'g1', vendor: 'Fisher', itemDescription: 'Conical tubes', requesterName: 'Sam', updatedAt: NOW - 1000 },
  { id: 't2', status: 'ordered', poNumber: 'PO-77', orderGroupId: 'g1', vendor: 'Fisher', itemDescription: 'Pipette tips', requesterName: 'Otto', updatedAt: NOW - 2000 },
  { id: 't3', status: 'received', poNumber: 'po-77', vendor: 'Fisher', itemDescription: 'Gloves', updatedAt: NOW - 3000 },
  { id: 't4', status: 'approved', vendor: 'Sigma', itemDescription: 'Trypsin', updatedAt: NOW - 500 },
  { id: 't5', status: 'placed', placedAt: NOW - 10 * 86400000, itemDescription: 'FBS', updatedAt: NOW - 10 * 86400000 },
  { id: 't6', status: 'placed', placedAt: NOW - 90 * 86400000, itemDescription: 'Old', updatedAt: NOW - 90 * 86400000 },
  { id: 't7', status: 'requested', itemDescription: 'Not yet approved', updatedAt: NOW },
  { id: 't8', status: 'received', receiptUrl: 'https://x/receipt-old.pdf', receiptStoragePath: 'procurement/t8/receipt-1-old.pdf', receivedAt: NOW - 5000, receivedByName: 'Bo', poUrl: 'https://x/po.pdf', poStoragePath: 'procurement/t8/po-1.pdf', orderedAt: NOW - 9000, updatedAt: NOW - 5000 },
];
eq(C.orderSiblings(T[0], T).map(t => t.id), ['t2', 't3'], 'the other requests on the order: same group, or the same PO # (case-blind)');
eq(C.orderSiblings(T[3], T), [], 'no PO and no group: no siblings');
eq(C.docLinkCandidates(T, NOW).map(t => t.id), ['t4', 't1', 't2', 't3', 't8', 't5'], 'linkable: approved / ordered / arrived + put away in the last 60 days, newest first; not requested, not long placed');

const rec = C.buildDocRecord({ id: 'D1', kind: 'receipt', file: { name: 'Fisher receipt.pdf', size: 3000, type: 'application/pdf' }, url: 'https://u', ticketIds: ['t1', 't2', 't1', ''], note: ' boxes 1-2 ', source: 'upload', actor: buyer, stamp: STAMP, tickets: T });
eq(rec, { kind: 'receipt', fileName: 'Fisher receipt.pdf', contentType: 'application/pdf', size: 3000, storagePath: 'procurement/docs/D1/Fisher_receipt.pdf', url: 'https://u',
          ticketIds: ['t1', 't2'], poNumber: 'PO-77', vendor: 'Fisher', docDate: '', note: 'boxes 1-2', source: 'upload',
          uploadedBy: 'buy', uploadedByName: 'Bo Buyer', uploadedAt: STAMP, updatedAt: STAMP, ingestStatus: 'pending', ingestedAt: null, ingestedItemIds: [], ingestNote: '' },
   'the record: deduped requests, PO # and vendor taken from them when blank, pending for the later inventory read');
eq(C.buildDocRecord({ id: 'D2', kind: 'requisition', file: { name: 'req.pdf', size: 1 }, ticketIds: ['t1', 't4'], tickets: T, actor: buyer, stamp: STAMP }).vendor, '', 'requests that disagree on the vendor leave it blank');
eq(C.buildDocRecord({ id: 'D3', kind: 'bogus', file: { name: 'x.jpg', size: 1 }, docDate: '2026-02-30', poNumber: ' 99 ', actor: buyer, stamp: STAMP, source: 'weird' }).kind + '|' +
   C.buildDocRecord({ id: 'D3', kind: 'bogus', file: { name: 'x.jpg', size: 1 }, docDate: '2026-02-30', poNumber: ' 99 ', actor: buyer, stamp: STAMP }).docDate + '|' +
   C.buildDocRecord({ id: 'D3', kind: 'po', file: { name: 'x.jpg', size: 1 }, poNumber: ' 99 ', actor: buyer, stamp: STAMP, source: 'order' }).source, 'other||order', 'unknown kind → other; a non-date is dropped; source order kept');
eq(C.buildDocRecord({ id: 'D4', file: { name: 'a', size: 1 }, ticketIds: Array.from({ length: 60 }, (_, i) => 'x' + i), actor: buyer, stamp: STAMP }).ticketIds.length, 50, 'at most 50 requests (the rules cap)');
eq(C.docEditPatch({ kind: 'invoice', ticketIds: ['t3', 't3'], poNumber: ' A1 ', vendor: 'VWR', docDate: '2026-10-20', note: 'n', storagePath: 'evil', uploadedBy: 'evil' }, STAMP),
   { kind: 'invoice', ticketIds: ['t3'], poNumber: 'A1', vendor: 'VWR', docDate: '2026-10-20', note: 'n', updatedAt: STAMP }, 'an edit touches only the editable fields');

const docs = [
  { id: 'a', kind: 'receipt', ticketIds: ['t1'], uploadedAt: NOW - 100, fileName: 'r1.pdf', storagePath: 'procurement/docs/a/r1.pdf', url: 'https://a', uploadedByName: 'Bo Buyer' },
  { id: 'b', kind: 'requisition', ticketIds: ['t1', 't2'], uploadedAt: NOW - 10, fileName: 'req.pdf', storagePath: 'procurement/docs/b/req.pdf', url: 'https://b', note: 'department copy' },
  { id: 'c', kind: 'po', ticketIds: ['t8'], uploadedAt: NOW - 50, fileName: 'po.pdf', storagePath: 'procurement/t8/po-1.pdf', url: 'https://x/po.pdf' },
];
eq(C.docsForTicket(docs, 't1').map(d => d.id), ['b', 'a'], 'a request’s documents, newest first');
const leg = C.legacyAttachments(T, docs);
eq(leg.map(d => [d.id, d.kind, d.fileName, d.ticketIds[0], d.uploadedByName, d.legacy]), [['legacy-receipt-t8', 'receipt', 'receipt-1-old.pdf', 't8', 'Bo', true]],
   'the V3.813 request files with no record show as legacy rows (a PO already filed is not repeated)');
eq(C.docRows(docs, T).map(d => d.id), ['b', 'c', 'a', 'legacy-receipt-t8'], 'the list: records and legacy files, newest first');
eq(C.searchDocs(C.docRows(docs, T), 'pipette', T).map(d => d.id), ['b'], 'search reaches a linked request’s item');
eq(C.searchDocs(C.docRows(docs, T), 'requisition department', T).map(d => d.id), ['b'], 'every word must match (kind + note)');
eq(C.searchDocs(C.docRows(docs, T), '', T).length, 4, 'no search: everything');

console.log(`\nprocurement-core: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
