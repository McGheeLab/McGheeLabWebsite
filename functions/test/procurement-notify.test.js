/* ================================================================
   procurement-notify.test.js — who hears what (functions/procurement-notify.js)
       node functions/test/procurement-notify.test.js
   Pins, without an emulator: every transition's audience, the actor
   exclusion, the same-status cases (note / flag / edit), the delete
   no-op, and the daily sweep's grouping.
   ================================================================ */
'use strict';
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'test-project';
let I;
try { I = require('../procurement-notify')._internal; }
catch (e) { console.error('Could not load procurement-notify.js:', e.message); process.exit(1); }

let pass = 0, fail = 0; const failures = [];
function check(name, cond, detail) { if (cond) { pass++; return; } fail++; failures.push(name + (detail ? '\n      ' + detail : '')); }
const aud = (items) => items.map((i) => i.audience).sort().join(',');
const base = { itemDescription: 'PEG 6000, 100 g', requesterName: 'Sam', requestedBy: 'stu', estimatedCost: 37.5, urgency: 'routine', watcherUids: ['stu', 'app'], lastActorUid: 'stu' };
const T = (over) => Object.assign({}, base, over);

/* created */
check('create → approvers', aud(I.plan(null, T({ status: 'requested' }))) === 'approvers');
check('create body names requester, item, estimate', /Sam: PEG 6000, 100 g · ~\$37\.50/.test(I.plan(null, T({ status: 'requested' }))[0].body));
check('urgent create is flagged urgent in the title', /urgent/.test(I.plan(null, T({ status: 'requested', urgency: 'urgent' }))[0].title) && I.plan(null, T({ status: 'requested', urgency: 'urgent' }))[0].urgent === true);
check('create in any other status tells nobody', I.plan(null, T({ status: 'approved' })).length === 0);
check('delete tells nobody', I.plan(T({ status: 'requested' }), null).length === 0);

/* transitions */
check('→ needs_info → requester', aud(I.plan(T({ status: 'requested' }), T({ status: 'needs_info', question: 'Which MW?', questionByName: 'PI' }))) === 'requester');
check('question text in body', /PI: Which MW\?/.test(I.plan(T({ status: 'requested' }), T({ status: 'needs_info', question: 'Which MW?', questionByName: 'PI' }))[0].body));
check('needs_info → requested (answered) → approvers', aud(I.plan(T({ status: 'needs_info' }), T({ status: 'requested', notes: [{ kind: 'answer', text: '6000' }] }))) === 'approvers');
check('answer text in body', /6000/.test(I.plan(T({ status: 'needs_info' }), T({ status: 'requested', notes: [{ kind: 'answer', text: '6000' }] }))[0].body));
check('answered by EDITING (no new note) → approvers, body carries the edit note', (() => { const p = I.plan(T({ status: 'needs_info', notes: [{ id: 'q', kind: 'question', text: 'MW?' }] }), T({ status: 'requested', notes: [{ id: 'q', kind: 'question', text: 'MW?' }], history: [{ id: 'h', action: 'edit', note: 'Changed vendor (answers the open question)' }] })); return aud(p) === 'approvers' && /Changed vendor/.test(p[0].body); })());
check('approved → requested (edited after approval / un-approved) → approvers + requester', aud(I.plan(T({ status: 'approved' }), T({ status: 'requested', history: [{ action: 'edit', note: 'Changed unit cost' }] }))) === 'approvers,requester');
check('cancelled → requested (reopened) → approvers + requester', aud(I.plan(T({ status: 'cancelled' }), T({ status: 'requested' }))) === 'approvers,requester');
check('approved → denied also tells purchasers to stand down', aud(I.plan(T({ status: 'approved' }), T({ status: 'denied', piNotes: 'no' }))) === 'purchasers,requester');
check('approved → cancelled also tells purchasers', aud(I.plan(T({ status: 'approved' }), T({ status: 'cancelled' }))) === 'approvers,purchasers');
check('approver edits an APPROVED request → requester', (() => { const p = I.plan(T({ status: 'approved', history: [{ id: 'h1', action: 'approve' }] }), T({ status: 'approved', history: [{ id: 'h1', action: 'approve' }, { id: 'h2', action: 'edit', note: 'Changed quantity' }] })); return aud(p) === 'requester' && /Changed quantity/.test(p[0].body); })());
check('edit_order with a new ETA → watchers', (() => { const p = I.plan(T({ status: 'ordered', expectedDelivery: '2026-10-20', history: [{ id: 'h1', action: 'order' }] }), T({ status: 'ordered', expectedDelivery: '2026-11-02', history: [{ id: 'h1', action: 'order' }, { id: 'h2', action: 'edit_order' }] })); return aud(p) === 'watchers' && /Now expected 2026-11-02/.test(p[0].body); })());
check('edit_order that changes nothing visible tells nobody', I.plan(T({ status: 'ordered', expectedDelivery: 'x', poNumber: 'p', history: [{ id: 'h1', action: 'order' }] }), T({ status: 'ordered', expectedDelivery: 'x', poNumber: 'p', history: [{ id: 'h1', action: 'order' }, { id: 'h2', action: 'edit_order' }] })).length === 0);
check('→ approved → requester + purchasers', aud(I.plan(T({ status: 'requested' }), T({ status: 'approved', approvedByName: 'PI', piNotes: 'go' }))) === 'purchasers,requester');
check('purchasers are told what to charge', /charge to McGhee Startup · 1101935/.test(I.plan(T({ status: 'requested' }), T({ status: 'approved', fundingLabel: 'McGhee Startup · 1101935' })).find((i) => i.audience === 'purchasers').body));
check('approval note reaches the requester', I.plan(T({ status: 'requested' }), T({ status: 'approved', approvedByName: 'PI', piNotes: 'go' })).find((i) => i.audience === 'requester').body === 'By PI. go');
check('ordered → approved (undo) → requester only', aud(I.plan(T({ status: 'ordered' }), T({ status: 'approved' }))) === 'requester');
check('→ denied → requester with reason', (() => { const p = I.plan(T({ status: 'requested' }), T({ status: 'denied', piNotes: 'too expensive' })); return aud(p) === 'requester' && p[0].body === 'too expensive'; })());
check('→ ordered → watchers with PO + ETA', (() => { const p = I.plan(T({ status: 'approved' }), T({ status: 'ordered', poNumber: 'PO-1', expectedDelivery: '2026-10-25' })); return aud(p) === 'watchers' && /PO PO-1\. Expected 2026-10-25\./.test(p[0].body); })());
check('received → ordered (undo) → requester', aud(I.plan(T({ status: 'received' }), T({ status: 'ordered' }))) === 'requester');
check('→ received → watchers, asks to put it away', (() => { const p = I.plan(T({ status: 'ordered' }), T({ status: 'received', receivedByName: 'Otto' })); return aud(p) === 'watchers' && /Otto marked it received\. Put it away/.test(p[0].body); })());
check('→ placed → requester with location', (() => { const p = I.plan(T({ status: 'received' }), T({ status: 'placed', location: 'Freezer A', placedByName: 'Otto' })); return aud(p) === 'requester' && p[0].body === 'At Freezer A by Otto.'; })());
check('→ cancelled → approvers', aud(I.plan(T({ status: 'requested' }), T({ status: 'cancelled' }))) === 'approvers');

/* same status */
check('note added → watchers', (() => { const p = I.plan(T({ status: 'ordered', notes: [] }), T({ status: 'ordered', notes: [{ kind: 'note', byName: 'Otto', text: 'any news?' }] })); return aud(p) === 'watchers' && p[0].title === 'Otto on PEG 6000, 100 g' && p[0].body === 'any news?'; })());
check('a question/answer/decision note is NOT re-sent as a note', I.plan(T({ status: 'approved', notes: [] }), T({ status: 'approved', notes: [{ kind: 'decision', text: 'go' }] })).length === 0);
check('issue flagged → purchasers, urgent', (() => { const p = I.plan(T({ status: 'ordered', issue: null }), T({ status: 'ordered', issue: 'wrong item' })); return aud(p) === 'purchasers' && p[0].urgent === true; })());
check('issue cleared tells nobody', I.plan(T({ status: 'ordered', issue: 'x' }), T({ status: 'ordered', issue: null })).length === 0);
check('edit while requested → approvers', (() => { const p = I.plan(T({ status: 'requested', history: [{ id: 'h1', action: 'submit' }] }), T({ status: 'requested', history: [{ id: 'h1', action: 'submit' }, { id: 'h2', action: 'edit', note: 'Changed vendor' }] })); return aud(p) === 'approvers' && /Changed vendor/.test(p[0].body); })());
check('edit while ordered tells nobody', I.plan(T({ status: 'ordered', history: [{ id: 'h1', action: 'order' }] }), T({ status: 'ordered', history: [{ id: 'h1', action: 'order' }, { id: 'h2', action: 'edit_order' }] })).length === 0);
check('an unchanged write (same history) tells nobody', I.plan(T({ status: 'requested', history: [{ id: 'h1', action: 'edit' }] }), T({ status: 'requested', history: [{ id: 'h1', action: 'edit' }] })).length === 0);

/* V3.814 — change funding + edits by someone else */
{
  const H = (extra) => [{ id: 'h1', action: 'approve' }].concat(extra ? [extra] : []);
  const re = { id: 'h2', action: 'reassign', by: 'pi', byName: 'The PI', note: 'Now charged to ONR · 3062920 (was Startup · 1101935) — startup is closing' };
  const b = T({ status: 'ordered', fundingLabel: 'Startup · 1101935', history: H(), notes: [] });
  const a = T({ status: 'ordered', fundingLabel: 'ONR · 3062920', fundingChangedFrom: 'Startup · 1101935', fundingChangedByName: 'The PI', history: H(re), notes: [{ id: 'n1', kind: 'funding', text: re.note }], lastActorUid: 'pi' });
  const p = I.plan(b, a);
  check('reassign on an ORDERED ticket → requester + purchasers', aud(p) === 'purchasers,requester', JSON.stringify(p));
  check('requester body names who, to, from and why', /The PI moved it to ONR · 3062920 \(was Startup · 1101935\) — startup is closing\./.test(p.find((x) => x.audience === 'requester').body), p.find((x) => x.audience === 'requester').body);
  check('reassign title names the item', /^Funding changed: PEG 6000/.test(p.find((x) => x.audience === 'requester').title));
  check('purchasers told to move the charge on an ordered ticket', /already ordered; move the charge/.test(p.find((x) => x.audience === 'purchasers').body));
  const pr = I.plan(T({ status: 'requested', history: H(), notes: [] }), T({ status: 'requested', fundingLabel: 'ONR', history: H(re), notes: [{ id: 'n1', kind: 'funding', text: re.note }] }));
  check('reassign while REQUESTED → requester only (nobody is ordering yet)', aud(pr) === 'requester', JSON.stringify(pr));
  const pa = I.plan(T({ status: 'approved', history: H(), notes: [] }), T({ status: 'approved', fundingLabel: 'ONR', history: H(re), notes: [{ id: 'n1', kind: 'funding', text: re.note }] }));
  check('reassign while APPROVED → requester + purchasers (they charge it next)', aud(pa) === 'purchasers,requester');
  const pp = I.plan(T({ status: 'placed', history: H(), notes: [] }), T({ status: 'placed', fundingLabel: 'ONR', history: H(re), notes: [{ id: 'n1', kind: 'funding', text: re.note }] }));
  check('reassign while PLACED → requester only', aud(pp) === 'requester');
  check('the funding note itself does not ALSO fire as a watcher note', pr.length === 1 && pr[0].kind === 'funding');
  check('a reassign without a note has no dangling dash', !/—\s*\.$/.test(I.plan(T({ status: 'requested', history: H(), notes: [] }), T({ status: 'requested', fundingLabel: 'ONR', fundingChangedFrom: 'X', history: H({ id: 'h2', action: 'reassign', byName: 'PI', note: 'Now charged to ONR (was X)' }), notes: [] }))[0].body));
  const ed = I.plan(T({ status: 'requested', history: [{ id: 'h1', action: 'submit' }] }), T({ status: 'requested', history: [{ id: 'h1', action: 'submit' }, { id: 'h2', action: 'edit', by: 'pi', note: 'Changed project, funding string' }] }));
  check('an approver EDITING a requested ticket → approvers AND the requester', aud(ed) === 'approvers,requester', JSON.stringify(ed));
  check('… with "Your request was changed" + what changed', /Your request was changed/.test(ed.find((x) => x.audience === 'requester').title) && /Changed project, funding string/.test(ed.find((x) => x.audience === 'requester').body));
  const se = I.plan(T({ status: 'requested', history: [{ id: 'h1', action: 'submit' }] }), T({ status: 'requested', history: [{ id: 'h1', action: 'submit' }, { id: 'h2', action: 'edit', by: 'stu', note: 'Changed vendor' }] }));
  check('the requester editing their own request → approvers only (no self-notification)', aud(se) === 'approvers');
  check('created push says "recurring" when the request is', /· recurring$/.test(I.plan(null, T({ status: 'requested', purchaseType: 'recurring' }))[0].body) && !/recurring/.test(I.plan(null, T({ status: 'requested', purchaseType: 'one_time' }))[0].body));
}

/* audiences */
const A = { approvers: ['pi', 'app'], purchasers: ['pi', 'buy'] };
check('watchers = watcherUids ∪ requester, deduped', I.audienceUids('watchers', T({ watcherUids: ['app', 'stu', 'app'] }), A).sort().join() === 'app,stu');
check('requester audience', I.audienceUids('requester', T({}), A).join() === 'stu');
check('approvers audience from caps', I.audienceUids('approvers', T({}), A).join() === 'pi,app');
check('unknown audience is empty', I.audienceUids('nobody', T({}), A).length === 0);

/* sweep */
{
  const now = Date.parse('2026-10-19T15:00:00Z'), D = 86400000;
  const tix = [
    { id: 'a', status: 'requested', itemDescription: 'Old request', createdAt: now - 6 * D },
    { id: 'b', status: 'requested', itemDescription: 'Fresh request', createdAt: now - 1 * D },
    { id: 'c', status: 'ordered', itemDescription: 'Late order', poNumber: 'PO-9', expectedDelivery: '2026-10-10' },
    { id: 'd', status: 'ordered', itemDescription: 'On time', expectedDelivery: '2026-10-18' },
    { id: 'e', status: 'received', itemDescription: 'Box 1', receivedAt: now - 4 * D, receivedBy: 'oth', requestedBy: 'stu' },
    { id: 'f', status: 'received', itemDescription: 'Box 2', receivedAt: now - 5 * D, receivedBy: 'stu', requestedBy: 'stu' },
    { id: 'g', status: 'received', itemDescription: 'Box 3', receivedAt: now, receivedBy: 'stu', requestedBy: 'stu' },
  ];
  const s = I.sweepPlan(tix, now, A);
  const byTag = {}; s.forEach((x) => { (byTag[x.tag] = byTag[x.tag] || []).push(x); });
  check('stale requests → approvers, singular title', byTag['proc-sweep-requests'] && byTag['proc-sweep-requests'][0].uids.join() === 'pi,app' && /^A purchase request has waited/.test(byTag['proc-sweep-requests'][0].title), JSON.stringify(byTag['proc-sweep-requests']));
  check('overdue orders → purchasers, names the PO', byTag['proc-sweep-overdue'] && byTag['proc-sweep-overdue'][0].uids.join() === 'pi,buy' && /Late order \(PO PO-9\)/.test(byTag['proc-sweep-overdue'][0].body));
  check('unplaced → one item per person, counted', (() => {
    const u = byTag['proc-sweep-unplaced'] || []; const stu = u.find((x) => x.uids[0] === 'stu'), oth = u.find((x) => x.uids[0] === 'oth');
    return u.length === 2 && stu && /^2 packages/.test(stu.title) && oth && /^A package/.test(oth.title);
  })(), JSON.stringify(byTag['proc-sweep-unplaced']));
  check('nothing stale → nothing sent', I.sweepPlan([tix[1], tix[3], tix[6]], now, A).length === 0);
  check('an old request answered yesterday is not stale (lastActivityAt restarts the clock)', I.sweepPlan([{ id: 'z', status: 'requested', itemDescription: 'Z', createdAt: now - 30 * D, lastActivityAt: new Date(now - D).toISOString() }], now, A).length === 0);
  check('unplaced sweep never addresses a guest_ uid', I.sweepPlan([{ id: 'g', status: 'received', itemDescription: 'G', receivedAt: now - 4 * D, receivedBy: 'guest_x', requestedBy: 'guest_x' }], now, A).length === 0);
  check('no approvers configured → the stale item is dropped, not sent to []', I.sweepPlan([tix[0]], now, { approvers: [], purchasers: [] }).length === 0);
}

/* helpers */
check('short() truncates with an ellipsis', I.short('x'.repeat(100), 20).length === 20 && /…$/.test(I.short('x'.repeat(100), 20)));
check('money()', I.money(1234.5) === '$1,234.50' && I.money('') === '');
check('toMs() handles Timestamp-like, Date, ISO, YYYY-MM-DD', I.toMs({ seconds: 5 }) === 5000 && I.toMs(new Date(7)) === 7 && I.toMs('2026-10-19') > 0 && I.toMs('junk') === 0);

console.log(`procurement-notify: ${pass} passed, ${fail} failed`);
if (failures.length) { console.log(failures.map((f) => '  FAIL ' + f).join('\n')); }
process.exit(fail ? 1 : 0);
