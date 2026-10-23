/* ================================================================
   meetings.test.js — decision logic for functions/meetings.js
   ================================================================
       node functions/test/meetings.test.js

   Pins down, without an emulator:
     • the day-of-week → audience matrix for a Friday meeting (Mon presenter,
       Wed submitters, Thu deck, day-before chase only in the pm pass),
     • dedupe flags stopping a second send,
     • who counts as a submitter (never presenters, reviewers, guests,
       hidden, collaborators),
     • flash / break weeks,
     • swap transitions (created / accepted / declined / cancelled, and
       the no-ops),
     • the onMeetingWritten early-exit guard: a minutes-only diff MUST be a
       null transition, because that trigger fires on every keystroke.
   ================================================================ */

'use strict';

process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'test-project';

let I;
try {
  I = require('../meetings')._internal;
} catch (e) {
  console.error('Could not load meetings.js:', e.message);
  process.exit(1);
}

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  failures.push(name + (detail ? '\n      ' + detail : ''));
}

/* ── fixtures ── */
const members = [
  { uid: 'pi', role: 'admin', category: 'pi' },
  { uid: 'cason', role: 'editor', category: 'grad' },
  { uid: 'gabe', role: 'editor', category: 'grad' },
  { uid: 'zeke', role: 'contributor', category: 'undergrad' },
  { uid: 'ally', role: 'contributor', category: 'undergrad' },
  { uid: 'guest', role: 'guest' },
  { uid: 'ghost', role: 'contributor', hidden: true },
  { uid: 'collab', role: 'contributor', category: 'collaborator' },
  { uid: 'alum', role: 'contributor', category: 'alumni' },
];
const names = { pi: 'Alex McGhee', cason: 'Cason Hancock', gabe: 'Gabriel Declercq', zeke: 'Zeke Pangelinan', ally: 'Allison Friedholm' };
function ctx(today, minutes) {
  return { today, minutes: minutes == null ? 9 * 60 : minutes, members, reviewerUids: ['pi'], coordinatorUids: ['cason'], names: (uid, fb) => names[uid] || fb || '' };
}
const FRI = '2026-09-11';
function meeting(extra) {
  return Object.assign({
    id: 'm1', date: FRI, time: '11:00', location: 'BSRL 100', status: 'upcoming', kind: 'standard',
    presenters: { gabe: { slot: 0, name: 'Gabriel Declercq', link: null } },
    updates: { submissions: {}, deck: null, review: { status: null } }, reminded: {},
  }, extra || {});
}
const flags = (plan) => plan.map((p) => p.flag).sort();

/* ── helpers ── */
check('daysBetween Fri→Mon = 4', I.daysBetween('2026-09-07', FRI) === 4);
check('shiftDateStr crosses a month', I.shiftDateStr('2026-09-30', 1) === '2026-10-01');
check('presentersOf normalizes the map, sorted by slot',
  I.presentersOf({ presenters: { b: { slot: 1 }, a: { slot: 0 } } }).map((p) => p.uid).join() === 'a,b');
check('presentersOf tolerates the legacy array', I.presentersOf({ presenters: [{ uid: 'x', name: 'X' }] })[0].uid === 'x');
check('presentersOf tolerates legacy presenterId', I.presentersOf({ presenterId: 'y' })[0].uid === 'y');

/* ── submitters ── */
{
  const s = I.submittersFor(meeting(), members, ['pi']).map((u) => u.uid).sort();
  check('submitters = members − presenter − PI − guest/hidden/collaborator', s.join() === 'ally,cason,zeke', s.join());
}

/* ── roster (V3.744) ── */
{
  const s0 = I.submittersFor(meeting(), members, ['pi']).map((u) => u.uid);
  check('alumni never owe slides by default', s0.indexOf('alum') < 0, s0.join());
  const rostered = I.applyRoster(members, { attendeeUids: ['cason', 'zeke', 'alum'] });
  const s1 = I.submittersFor(meeting(), rostered, ['pi']).map((u) => u.uid).sort();
  check('a saved roster is the truth — even an alumnus ticked "at meetings" owes slides; ally (unticked) does not', s1.join() === 'alum,cason,zeke', s1.join());
  const flashR = I.planReminders(meeting({ kind: 'flash', presenters: {} }), Object.assign(ctx('2026-09-07'), { members: rostered }));
  check('flash-week nudge goes to the roster only', flashR[0].uids.slice().sort().join() === 'alum,cason,zeke', flashR[0].uids.join());
  const none = I.applyRoster(members, {});
  check('no roster saved → category defaults (pi attends, alumni/guest/hidden/collab do not)', I.attendees(none).map((u) => u.uid).sort().join() === 'ally,cason,gabe,pi,zeke');
}

/* ── the week, morning passes ── */
{
  const sun = I.planReminders(meeting(), ctx('2026-09-06'));
  check('Sunday (5 days out): nothing yet', sun.length === 0, flags(sun).join());

  const mon = I.planReminders(meeting(), ctx('2026-09-07'));
  check('Monday: presenter reminder only', flags(mon).join() === 'presenter', flags(mon).join());
  check('Monday presenter notice goes to gabe', mon[0].uids.join() === 'gabe');
  check('Monday notice names the weekday and asks for the link', /Friday/.test(mon[0].title) && /slides link/.test(mon[0].body));

  const tue = I.planReminders(meeting({ reminded: { presenter: true } }), ctx('2026-09-08'));
  check('Tuesday after the flag: nothing', tue.length === 0, flags(tue).join());

  const wed = I.planReminders(meeting({ reminded: { presenter: true } }), ctx('2026-09-09'));
  check('Wednesday: submit call', flags(wed).join() === 'submitCall', flags(wed).join());
  check('submit call goes to the three who owe slides', wed[0].uids.slice().sort().join() === 'ally,cason,zeke', wed[0].uids.join());
  check('submit call names the presenter and the Thursday deadline', /Gabriel/.test(wed[0].title) && /Sep 10/.test(wed[0].title));

  const wedPartial = I.planReminders(meeting({ reminded: { presenter: true }, updates: { submissions: { zeke: { link: {} } }, deck: null, review: {} } }), ctx('2026-09-09'));
  check('submit call skips people who already submitted', wedPartial[0].uids.slice().sort().join() === 'ally,cason', wedPartial[0].uids.join());

  const thu = I.planReminders(meeting({ reminded: { presenter: true, submitCall: true } }), ctx('2026-09-10'));
  check('Thursday am: deck call', flags(thu).join() === 'deckCall', flags(thu).join());
  check('deck call counts 0 of 3 and lists the missing', /0 of 3/.test(thu[0].title) && /Allison, Cason, Zeke|Ally|Cason/.test(thu[0].body));

  const thuDeck = I.planReminders(meeting({ reminded: { presenter: true, submitCall: true }, updates: { submissions: {}, deck: { fileId: 'd' }, review: { status: 'pending' } } }), ctx('2026-09-10'));
  check('Thursday with a deck: review call to the PI (fallback), no deck call', flags(thuDeck).join() === 'reviewCall' && thuDeck[0].uids.join() === 'pi', flags(thuDeck).join());

  const thuAmChase = I.planReminders(meeting({ reminded: { presenter: true, submitCall: true, deckCall: true } }), ctx('2026-09-10', 9 * 60));
  check('Thursday 9am: no day-before chase yet', thuAmChase.length === 0, flags(thuAmChase).join());

  const thuPm = I.planReminders(meeting({ reminded: { presenter: true, submitCall: true, deckCall: true } }), ctx('2026-09-10', 16 * 60));
  check('Thursday 4pm, no deck: chase the presenter + coordinator', flags(thuPm).join() === 'dayBefore' && thuPm[0].uids.slice().sort().join() === 'cason,gabe', JSON.stringify(thuPm));

  const thuPmReview = I.planReminders(meeting({ reminded: { presenter: true, submitCall: true, deckCall: true, reviewCall: true }, updates: { submissions: {}, deck: { fileId: 'd' }, review: { status: 'pending' } } }), ctx('2026-09-10', 16 * 60));
  check('Thursday 4pm, deck posted but unreviewed: chase the PI', flags(thuPmReview).join() === 'dayBefore' && thuPmReview[0].uids.join() === 'pi', JSON.stringify(thuPmReview));

  const thuPmApproved = I.planReminders(meeting({ reminded: { presenter: true, submitCall: true, deckCall: true, reviewCall: true }, updates: { submissions: {}, deck: { fileId: 'd' }, review: { status: 'approved' } } }), ctx('2026-09-10', 16 * 60));
  check('Thursday 4pm, approved: silence', thuPmApproved.length === 0, flags(thuPmApproved).join());

  const fri = I.planReminders(meeting({ reminded: { presenter: true, submitCall: true, deckCall: true, dayBefore: true } }), ctx(FRI));
  check('Friday with all flags: nothing', fri.length === 0, flags(fri).join());

  const firstLookWed = I.planReminders(meeting(), ctx('2026-09-09'));
  check('a meeting first seen on Wednesday gets presenter + submit call in one pass', flags(firstLookWed).join() === 'presenter,submitCall', flags(firstLookWed).join());
}

/* ── kinds and statuses ── */
{
  const flash = I.planReminders(meeting({ kind: 'flash', presenters: {} }), ctx('2026-09-07'));
  check('flash week: one reminder to every visible member', flags(flash).join() === 'presenter' && flash[0].uids.slice().sort().join() === 'ally,cason,gabe,pi,zeke', JSON.stringify(flash.map((f) => f.uids)));
  const flashWed = I.planReminders(meeting({ kind: 'flash', presenters: {}, reminded: { presenter: true } }), ctx('2026-09-09'));
  check('flash week: no submit/deck pipeline', flashWed.length === 0);
  check('break week: nothing', I.planReminders(meeting({ kind: 'break', status: 'cancelled' }), ctx('2026-09-07')).length === 0);
  check('cancelled: nothing', I.planReminders(meeting({ status: 'cancelled' }), ctx('2026-09-07')).length === 0);
  check('completed: nothing', I.planReminders(meeting({ status: 'completed' }), ctx('2026-09-07')).length === 0);
  check('no presenter assigned: no presenter/submit/deck calls', I.planReminders(meeting({ presenters: {} }), ctx('2026-09-09')).length === 0);
  check('more than 7 days out: nothing', I.planReminders(meeting(), ctx('2026-09-01')).length === 0);
  check('already past: nothing', I.planReminders(meeting(), ctx('2026-09-12')).length === 0);
  const legacy = I.planReminders(meeting({ presenters: [{ uid: 'zeke', name: 'Zeke' }] }), ctx('2026-09-07'));
  check('legacy array presenters still get reminded', legacy[0] && legacy[0].uids.join() === 'zeke');
}

/* ── swap transitions ── */
{
  const P = { status: 'pending' }, A = { status: 'accepted' }, D = { status: 'declined' }, C = { status: 'cancelled' };
  check('create pending → created', I.swapTransition(null, P) === 'created');
  check('create already-accepted → null (rules forbid it anyway)', I.swapTransition(null, A) === null);
  check('pending → accepted', I.swapTransition(P, A) === 'accepted');
  check('pending → declined', I.swapTransition(P, D) === 'declined');
  check('pending → cancelled', I.swapTransition(P, C) === 'cancelled');
  check('accepted → accepted (executedAt stamp) is a no-op', I.swapTransition(A, Object.assign({}, A, { executedAt: 'x' })) === null);
  check('deleted → null', I.swapTransition(P, null) === null);
}

/* ── meeting transitions — the early-exit guard ── */
{
  const base = meeting();
  const typed = Object.assign({}, base, { minutes: { text: 'hello', items: { ag1: { notes: 'x' } } } });
  check('minutes-only diff is a NULL transition (guard exits)', I.meetingTransition(base, typed) === null);
  const actions = Object.assign({}, base, { actionItems: [{ id: 'a', text: 'x' }] });
  check('action-item diff is a null transition', I.meetingTransition(base, actions) === null);
  const deck = Object.assign({}, base, { updates: { submissions: {}, deck: { fileId: 'd1' }, review: { status: 'pending' } } });
  const t1 = I.meetingTransition(base, deck);
  check('deck posted → deckPosted, not reviewChanged (pending is not a decision)', t1 && t1.deckPosted && !t1.reviewChanged, JSON.stringify(t1));
  const sameDeck = I.meetingTransition(deck, Object.assign({}, deck, { minutes: { text: 'y' } }));
  check('same deck + typing → null', sameDeck === null);
  const approved = Object.assign({}, deck, { updates: { submissions: {}, deck: { fileId: 'd1' }, review: { status: 'approved', by: 'pi' } } });
  const t2 = I.meetingTransition(deck, approved);
  check('review approved → reviewChanged only', t2 && t2.reviewChanged && !t2.deckPosted && !t2.newPresenters.length, JSON.stringify(t2));
  const changes = Object.assign({}, deck, { updates: { submissions: {}, deck: { fileId: 'd1' }, review: { status: 'changes', comment: 'axis labels' } } });
  check('changes requested → reviewChanged', I.meetingTransition(deck, changes).reviewChanged === true);
  const added = Object.assign({}, base, { presenters: { gabe: { slot: 0 }, zeke: { slot: 1 } } });
  const t3 = I.meetingTransition(base, added);
  check('new presenter → newPresenters = [zeke]', t3 && t3.newPresenters.join() === 'zeke', JSON.stringify(t3));
  const edited = Object.assign({}, base, { presenters: { gabe: { slot: 0, title: 'New title' } } });
  check('presenter editing their own title → null', I.meetingTransition(base, edited) === null);
  const created = I.meetingTransition(null, base, '2026-09-04');
  check('brand-new meeting a week out → newPresenters (seed/generate)', created && created.newPresenters.join() === 'gabe');
  const farOut = I.meetingTransition(null, Object.assign({}, base, { date: '2026-12-18' }), '2026-09-04');
  check('brand-new meeting 3 months out → NO burst push (Monday reminder covers it)', farOut === null, JSON.stringify(farOut));
  const reassignFar = I.meetingTransition(Object.assign({}, base, { date: '2026-12-18', presenters: {} }), Object.assign({}, base, { date: '2026-12-18' }), '2026-09-04');
  check('reassignment on an EXISTING far-out doc still notifies', reassignFar && reassignFar.newPresenters.join() === 'gabe');
  check('deleted meeting → null', I.meetingTransition(base, null) === null);
}

/* ── verdict ── */
console.log(`meetings.test.js: ${pass} passed, ${fail} failed`);
if (failures.length) { console.log(failures.map((f) => '  FAIL ' + f).join('\n')); }
process.exit(fail ? 1 : 0);
