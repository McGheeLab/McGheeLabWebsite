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

/* ── V3.938 one-on-ones: occurrence math ── */
{
  // 2026-11-03 is a Tuesday
  const weekly = { id: 's1', hostUid: 'pi', weekday: 2, time: '14:00', duration: 30, cadence: 'weekly', startDate: '2026-11-03', endDate: '2026-12-15', active: true, subscriberUid: 'gabe', skips: { '2026-11-24': { by: 'gabe', reason: 'conference' } } };
  check('weekday math: 2026-11-03 is Tuesday (2)', I.weekdayOf('2026-11-03') === 2);
  check('occurs on the first date', I.slotOccursOn(weekly, '2026-11-03') === 'on');
  check('occurs a week later', I.slotOccursOn(weekly, '2026-11-10') === 'on');
  check('not on a Wednesday', I.slotOccursOn(weekly, '2026-11-04') === null);
  check('not before startDate', I.slotOccursOn(weekly, '2026-10-27') === null);
  check('on the end date itself', I.slotOccursOn(weekly, '2026-12-15') === 'on');
  check('not after endDate', I.slotOccursOn(weekly, '2026-12-22') === null);
  check('a skipped week reads skipped', I.slotOccursOn(weekly, '2026-11-24') === 'skipped');
  check('an ended slot never occurs', I.slotOccursOn(Object.assign({}, weekly, { active: false }), '2026-11-10') === null);
  check('no endDate = open-ended', I.slotOccursOn(Object.assign({}, weekly, { endDate: null }), '2027-03-02') === 'on');
  const biweekly = Object.assign({}, weekly, { cadence: 'biweekly' });
  check('biweekly: anchor week on', I.slotOccursOn(biweekly, '2026-11-03') === 'on');
  check('biweekly: next week off', I.slotOccursOn(biweekly, '2026-11-10') === null);
  check('biweekly: two weeks later on', I.slotOccursOn(biweekly, '2026-11-17') === 'on');
  check('biweekly: three weeks later off', I.slotOccursOn(biweekly, '2026-11-24') === null);
  check('biweekly: anchored on the FIRST OCCURRENCE on/after startDate (a Sunday start → Tuesday the 3rd is week 0)',
    I.slotOccursOn(Object.assign({}, biweekly, { startDate: '2026-11-01', weekday: 2 }), '2026-11-03') === 'on'
    && I.slotOccursOn(Object.assign({}, biweekly, { startDate: '2026-11-01', weekday: 2 }), '2026-11-10') === null
    && I.slotOccursOn(Object.assign({}, biweekly, { startDate: '2026-11-01', weekday: 2 }), '2026-11-17') === 'on');
  check('firstOnOrAfter: Sunday Nov 1 → Tuesday Nov 3; Tuesday Nov 3 → itself', I.firstOnOrAfter('2026-11-01', 2) === '2026-11-03' && I.firstOnOrAfter('2026-11-03', 2) === '2026-11-03');
}

/* ── V3.938 one-on-ones: slot transitions ── */
{
  const open = { hostUid: 'pi', hostName: 'Alex McGhee', weekday: 2, time: '14:00', duration: 30, cadence: 'weekly', startDate: '2026-11-03', endDate: null, active: true, subscriberUid: null, subscriberName: '', subscribedBy: null, skips: {}, updatedBy: 'pi' };
  const types = (ev) => ev.map((e) => e.type).join(',');
  check('creating an OPEN slot notifies nobody', types(I.slotTransition(null, open)) === '');
  check('creating a RESERVED slot → assigned', types(I.slotTransition(null, Object.assign({}, open, { subscriberUid: 'gabe', subscribedBy: 'host' }))) === 'assigned');
  const booked = Object.assign({}, open, { subscriberUid: 'gabe', subscriberName: 'Gabriel Declercq', subscribedBy: 'self', updatedBy: 'gabe' });
  const t1 = I.slotTransition(open, booked);
  check('student writes own uid → subscribed (to the host)', types(t1) === 'subscribed' && t1[0].uid === 'gabe', JSON.stringify(t1));
  const reserved = Object.assign({}, open, { subscriberUid: 'gabe', subscribedBy: 'host', updatedBy: 'pi' });
  check('host books a student → assigned (to the student)', types(I.slotTransition(open, reserved)) === 'assigned');
  const left = Object.assign({}, booked, { subscriberUid: null, subscriberName: '', subscribedBy: null, updatedBy: 'gabe' });
  check('student releases → left (to the host)', types(I.slotTransition(booked, left)) === 'left');
  const removed = Object.assign({}, booked, { subscriberUid: null, subscribedBy: null, updatedBy: 'pi' });
  check('host unbooks → removed (to the student)', types(I.slotTransition(booked, removed)) === 'removed');
  const swapped = Object.assign({}, booked, { subscriberUid: 'zeke', subscriberName: 'Zeke', subscribedBy: 'host', updatedBy: 'pi' });
  const t2 = I.slotTransition(booked, swapped);
  check('host swaps the student → removed(gabe) + assigned(zeke)', types(t2) === 'removed,assigned' && t2[0].uid === 'gabe' && t2[1].uid === 'zeke', JSON.stringify(t2));
  check('ending a booked slot → ended', types(I.slotTransition(booked, Object.assign({}, booked, { active: false, updatedBy: 'pi' }))) === 'ended');
  check('ending an OPEN slot → nothing', types(I.slotTransition(open, Object.assign({}, open, { active: false }))) === '');
  check('deleting a booked slot → deleted', types(I.slotTransition(booked, null)) === 'deleted');
  check('deleting an open slot → nothing', types(I.slotTransition(open, null)) === '');
  const skipped = Object.assign({}, booked, { skips: { '2026-11-24': { by: 'gabe', reason: 'conference' } }, updatedBy: 'gabe' });
  const t3 = I.slotTransition(booked, skipped);
  check('a new skip → skipped with date, by and reason', types(t3) === 'skipped' && t3[0].date === '2026-11-24' && t3[0].by === 'gabe' && t3[0].reason === 'conference', JSON.stringify(t3));
  const t4 = I.slotTransition(skipped, Object.assign({}, booked, { updatedBy: 'pi' }));
  check('removing a skip → unskipped, by whoever wrote', types(t4) === 'unskipped' && t4[0].by === 'pi', JSON.stringify(t4));
  check('host moves the time of a booked slot → changed', types(I.slotTransition(booked, Object.assign({}, booked, { time: '15:00', updatedBy: 'pi' }))) === 'changed');
  check('host moves the time of an OPEN slot → nothing', types(I.slotTransition(open, Object.assign({}, open, { time: '15:00' }))) === '');
  check('a note edit on a booked slot → nothing (not a time field)', types(I.slotTransition(booked, Object.assign({}, booked, { note: 'bring figures' }))) === '');
  check('the reminder stamp → nothing (the trigger must exit)', types(I.slotTransition(booked, Object.assign({}, booked, { lastReminded: '2026-11-10' }))) === '');
  check('changing the time AND the student → removed + assigned, not changed', types(I.slotTransition(booked, Object.assign({}, swapped, { time: '15:00' }))) === 'removed,assigned');
}

/* ── V3.938 one-on-ones: the afternoon-before reminder plan ── */
{
  const n = (uid, fb) => ({ pi: 'Alex McGhee', gabe: 'Gabriel Declercq', zeke: 'Zeke Pangelinan', cason: 'Cason Hancock' }[uid] || fb || '');
  // today Monday 2026-11-09 → tomorrow Tuesday 2026-11-10
  const base = { hostUid: 'pi', weekday: 2, time: '14:00', duration: 30, cadence: 'weekly', startDate: '2026-11-03', endDate: null, active: true, skips: {} };
  const slots = [
    Object.assign({}, base, { id: 'a', subscriberUid: 'gabe', location: 'Office' }),
    Object.assign({}, base, { id: 'b', subscriberUid: 'zeke', time: '14:30' }),
    Object.assign({}, base, { id: 'c', subscriberUid: null }),                                   // open — nobody to remind
    Object.assign({}, base, { id: 'd', subscriberUid: 'gabe', hostUid: 'cason', weekday: 3 }),   // Wednesday — not tomorrow
    Object.assign({}, base, { id: 'e', subscriberUid: 'zeke', hostUid: 'cason', lastReminded: '2026-11-10' }),   // already reminded
    Object.assign({}, base, { id: 'f', subscriberUid: 'zeke', hostUid: 'cason', time: '09:00', skips: { '2026-11-10': { by: 'cason' } } }),   // skipped tomorrow
  ];
  check('morning pass sends nothing', I.planOneOnOneReminders(slots, { today: '2026-11-09', minutes: 9 * 60, names: n }).length === 0);
  const plan = I.planOneOnOneReminders(slots, { today: '2026-11-09', minutes: 16 * 60, names: n });
  const to = (uid) => plan.filter((p) => p.uids.includes(uid));
  check('afternoon pass: 3 notices — gabe, zeke, and ONE for the PI', plan.length === 3, JSON.stringify(plan.map((p) => [p.uids, p.title])));
  check('gabe is told about tomorrow 2:00 with Alex', to('gabe').length === 1 && /Alex/.test(to('gabe')[0].title) && /2:00 PM/.test(to('gabe')[0].title) && /Office/.test(to('gabe')[0].body));
  check('zeke is told once (the skipped and already-reminded slots are out)', to('zeke').length === 1 && /2:30 PM/.test(to('zeke')[0].title));
  check('the PI gets ONE grouped notice naming both students in time order', to('pi').length === 1 && /2 one-on-ones tomorrow/.test(to('pi')[0].title) && /Gabriel 2:00 PM · Zeke 2:30 PM/.test(to('pi')[0].body), to('pi')[0] && to('pi')[0].body);
  check('the grouped host notice stamps both slots', to('pi')[0].slotIds.join() === 'a,b');
  check('cason (no live slot tomorrow) is not notified', to('cason').length === 0);
  check('every notice carries the date to stamp', plan.every((p) => p.date === '2026-11-10'));
  const single = I.planOneOnOneReminders([slots[0]], { today: '2026-11-09', minutes: 16 * 60, names: n });
  check('a host with one meeting gets a named title, not "1 one-on-ones"', single.length === 2 && single.some((p) => p.uids[0] === 'pi' && /One-on-one with Gabriel tomorrow at 2:00 PM/.test(p.title)), JSON.stringify(single.map((p) => p.title)));
  check('biweekly off-week: nothing tomorrow', I.planOneOnOneReminders([Object.assign({}, slots[0], { cadence: 'biweekly' })], { today: '2026-11-09', minutes: 16 * 60, names: n }).length === 0);
  check('biweekly on-week: reminded', I.planOneOnOneReminders([Object.assign({}, slots[0], { cadence: 'biweekly' })], { today: '2026-11-16', minutes: 16 * 60, names: n }).length === 2);
}

/* ── V3.940 unique slots: who holds a date ── */
{
  // Tuesdays from 2026-11-03, one week at a time
  const u = { id: 'u1', hostUid: 'pi', weekday: 2, time: '14:00', duration: 30, cadence: 'weekly', startDate: '2026-11-03', endDate: null, active: true, mode: 'unique',
    subscriberUid: null, bookings: { gabe: { '2026-11-03': { name: 'Gabe', at: '2026-10-29T10:00:00Z' } }, zeke: { '2026-11-10': { name: 'Zeke', at: 'x' } } }, skips: {} };
  const h = (s, d) => I.slotHolderOn(s, d);
  check('a booked week → that student, "week"', h(u, '2026-11-03').state === 'week' && h(u, '2026-11-03').uid === 'gabe');
  check('another week → another student', h(u, '2026-11-10').uid === 'zeke');
  check('an unbooked week → open', h(u, '2026-11-17').state === 'open');
  check('not a meeting day → null', h(u, '2026-11-04') === null);
  const clash = Object.assign({}, u, { bookings: { gabe: { '2026-11-03': { at: '2026-10-29T10:00:00Z' } }, ally: { '2026-11-03': { at: '2026-10-29T09:00:00Z' } } } });
  check('two bookings on one date (a race) → the earlier wins', h(clash, '2026-11-03').uid === 'ally');
  const approved = Object.assign({}, u, { subscriberUid: 'gabe', subscribedFrom: '2026-11-17', bookings: { zeke: { '2026-11-24': { at: 'x' } } } });
  check('every week only from subscribedFrom', h(approved, '2026-11-10').state === 'open' && h(approved, '2026-11-17').state === 'standing' && h(approved, '2026-11-17').uid === 'gabe');
  check('someone else’s booked week beats the every-week holder', h(approved, '2026-11-24').state === 'week' && h(approved, '2026-11-24').uid === 'zeke');
  const sk = Object.assign({}, approved, { skips: { '2026-12-01': { by: 'gabe' } } });
  check('the holder’s skipped week reads skipped', h(sk, '2026-12-01').state === 'skipped');
}

/* ── V3.940 unique slots: transitions ── */
{
  const types = (ev) => ev.map((e) => e.type).join(',');
  const base = { hostUid: 'pi', weekday: 2, time: '14:00', duration: 30, cadence: 'weekly', startDate: '2026-11-03', active: true, mode: 'unique', subscriberUid: null, bookings: {}, recurRequests: {}, skips: {}, updatedBy: 'pi' };
  const T = (b, a) => I.slotTransition(b, a, '2026-10-29');
  const booked = Object.assign({}, base, { bookings: { gabe: { '2026-11-03': { name: 'Gabe', by: 'self', at: 'x' } } }, updatedBy: 'gabe' });
  let t = T(base, booked);
  check('student books a week → booked (by self → host is told)', types(t) === 'booked' && t[0].uid === 'gabe' && t[0].date === '2026-11-03' && t[0].by === 'self', JSON.stringify(t));
  const hostBooked = Object.assign({}, base, { bookings: { zeke: { '2026-11-10': { by: 'host', at: 'x' } } }, updatedBy: 'pi' });
  check('host books a student → booked by host', T(base, hostBooked)[0].by === 'host');
  const cancelled = Object.assign({}, booked, { bookings: { gabe: {} }, updatedBy: 'gabe' });
  t = T(booked, cancelled);
  check('student cancels → unbooked by self', types(t) === 'unbooked' && t[0].by === 'gabe');
  check('host cancels → unbooked by host', T(booked, Object.assign({}, cancelled, { updatedBy: 'pi' }))[0].by === 'pi');
  const asked = Object.assign({}, booked, { recurRequests: { gabe: { name: 'Gabe', from: '2026-11-03', at: 'x' } }, updatedBy: 'gabe' });
  t = T(booked, asked);
  check('student asks for every week → recurRequested (→ host) with from', types(t) === 'recurRequested' && t[0].from === '2026-11-03');
  check('book + ask in one write → booked + recurRequested', types(T(base, asked)) === 'booked,recurRequested');
  const approvedW = Object.assign({}, base, { subscriberUid: 'gabe', subscriberName: 'Gabe', subscribedBy: 'approved', subscribedFrom: '2026-11-03', bookings: { gabe: {} }, recurRequests: {}, updatedBy: 'pi' });
  t = T(asked, approvedW);
  check('host approves → ONE recurApproved — not "assigned", and the folded week is not "cancelled"', types(t) === 'recurApproved' && t[0].from === '2026-11-03', JSON.stringify(t));
  const declined = Object.assign({}, booked, { recurRequests: {}, updatedBy: 'pi' });
  check('host declines → recurDeclined, the booked week stays', types(T(asked, declined)) === 'recurDeclined');
  check('student withdraws → recurWithdrawn (quiet)', types(T(asked, Object.assign({}, declined, { updatedBy: 'gabe' }))) === 'recurWithdrawn');
  const madeEvery = Object.assign({}, base, { subscriberUid: 'gabe', subscribedBy: 'host', subscribedFrom: '2026-11-03', bookings: { gabe: {} }, updatedBy: 'pi' });
  check('host makes a booked week every week (no request) → assigned, no unbooked', types(T(booked, madeEvery)) === 'assigned');
  const backToOne = Object.assign({}, base, { subscriberUid: null, bookings: { gabe: { '2026-11-10': { by: 'host', at: 'y' } } }, updatedBy: 'pi' });
  t = T(madeEvery, backToOne);
  check('host turns every week back into one week → ONE madeOneWeek with the kept date', types(t) === 'madeOneWeek' && t[0].date === '2026-11-10', JSON.stringify(t));
  const withFuture = Object.assign({}, base, { bookings: { zeke: { '2026-11-10': { at: 'x' } }, ally: { '2026-10-20': { at: 'x' } } } });
  check('ending a slot tells the future bookers (not a past one)', types(T(withFuture, Object.assign({}, withFuture, { active: false }))) === 'ended' && T(withFuture, Object.assign({}, withFuture, { active: false }))[0].uid === 'zeke');
  check('deleting a slot tells the future bookers', types(T(withFuture, null)) === 'deleted');
  check('moving the time tells a future booker (they hold a week, not every week)', types(T(withFuture, Object.assign({}, withFuture, { time: '15:00' }))) === 'changed');
  check('switching mode alone → nothing', types(T(base, Object.assign({}, base, { mode: 'recurring' }))) === '');
}

/* ── V3.940 joined slots in the reminder ── */
{
  const n = (uid, fb) => ({ pi: 'Alex McGhee', gabe: 'Gabriel Declercq', zeke: 'Zeke Pangelinan' }[uid] || fb || '');
  const ctx = { today: '2026-11-09', minutes: 16 * 60, names: n };       // tomorrow = Tue 2026-11-10
  const base = { hostUid: 'pi', weekday: 2, duration: 30, cadence: 'weekly', startDate: '2026-11-03', endDate: null, active: true, skips: {}, location: 'Office' };
  const slots = [
    Object.assign({}, base, { id: 'a', time: '14:00', subscriberUid: 'gabe' }),
    Object.assign({}, base, { id: 'b', time: '14:30', subscriberUid: 'gabe' }),
    Object.assign({}, base, { id: 'c', time: '15:00', mode: 'unique', subscriberUid: null, bookings: { zeke: { '2026-11-10': { at: 'x' } } } }),
    Object.assign({}, base, { id: 'd', time: '15:30', mode: 'unique', subscriberUid: null, bookings: { zeke: { '2026-11-17': { at: 'x' } } } }),   // next week, not tomorrow
  ];
  const plan = I.planOneOnOneReminders(slots, ctx);
  const to = (uid) => plan.filter((p) => p.uids.includes(uid));
  check('gabe’s two back-to-back slots → ONE notice for 2:00–3:00 (1 hour)', to('gabe').length === 1 && /2:00 PM–3:00 PM \(1 hour\)/.test(to('gabe')[0].body) && to('gabe')[0].slotIds.join() === 'a,b', JSON.stringify(to('gabe')));
  check('zeke’s one-week booking tomorrow is reminded', to('zeke').length === 1 && /3:00 PM/.test(to('zeke')[0].title));
  check('the host’s notice lists the joined block as one: "Gabriel 2:00 PM–3:00 PM · Zeke 3:00 PM"', to('pi').length === 1 && /2 one-on-ones tomorrow/.test(to('pi')[0].title) && /Gabriel 2:00 PM–3:00 PM · Zeke 3:00 PM/.test(to('pi')[0].body), to('pi')[0] && to('pi')[0].body);
  check('the host notice stamps a, b and c (not next week’s d)', to('pi')[0].slotIds.slice().sort().join() === 'a,b,c');
  const split = I.planOneOnOneReminders([slots[0], Object.assign({}, slots[1], { subscriberUid: 'zeke' })], ctx);
  check('back-to-back but DIFFERENT people → two blocks, not joined', split.filter((p) => p.uids[0] !== 'pi').length === 2);
  const gap = I.planOneOnOneReminders([slots[0], Object.assign({}, slots[1], { time: '15:00' })], ctx);
  check('same person with a gap → two blocks', gap.filter((p) => p.uids[0] === 'gabe').length === 2);
}

/* ── verdict ── */
console.log(`meetings.test.js: ${pass} passed, ${fail} failed`);
if (failures.length) { console.log(failures.map((f) => '  FAIL ' + f).join('\n')); }
process.exit(fail ? 1 : 0);
