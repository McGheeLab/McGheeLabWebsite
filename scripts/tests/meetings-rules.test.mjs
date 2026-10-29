/* V3.743 — Lab Meetings rules test.
 *
 * What this pins down:
 *   1. The pre-V3.743 hole is CLOSED: a signed-in GUEST can no longer read or
 *      rewrite meeting docs (the old block was `request.auth != null`).
 *   2. `presenters` is a MAP keyed by uid, and a member may touch ONLY their
 *      own key — claim an empty slot, edit/release their own, never anyone
 *      else's. This is the whole reason presenters stopped being an array.
 *   3. The coordinator role is REAL: a coordinator (listed in
 *      meetingConfig/settings.coordinatorUids) creates/deletes meetings and
 *      writes config, but cannot appoint coordinators or reviewers.
 *   4. isMeetingCoordinator() with NO config doc must DENY, not raise — a
 *      raising branch poisons the whole || chain and would lock admins out
 *      too (the isChatAdmin() bug we deliberately did not copy).
 *   5. Topics: votes-only writes by anyone; text edits by author/coordinator.
 *   6. Swaps: only the target accepts/declines, only the requester cancels.
 *   7. Chores: coordinator owns `assignments`; each member owns ONLY their
 *      own key in `completions` (keyed by uid — the presenters trick again),
 *      so "tick a chore done for someone else" is a rules denial, not a UI
 *      courtesy.
 *
 * Setup + run (same harness as paper-create-rules.test.mjs):
 *   cd scripts/tests
 *   JAVA_HOME=/opt/homebrew/opt/openjdk@21 PATH=$JAVA_HOME/bin:$PATH \
 *     firebase emulators:exec --only firestore --project demo-mcgheelab-mtg \
 *     "node meetings-rules.test.mjs"
 *
 * Output marks: ok / HOLE (allowed, should deny) / BREAK (denied, should allow).
 */
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { readFileSync } from 'node:fs';
import {
  doc, setDoc, getDoc, getDocs, updateDoc, deleteDoc, collection, deleteField,
  writeBatch, setLogLevel
} from 'firebase/firestore';

setLogLevel('silent');

// RULES_FILE=<path> runs the suite against another copy (V3.938: the scratch
// deploy file = live ruleset + one hunk, before `firebase deploy --config`).
const RULES = process.env.RULES_FILE || new URL('../../firestore.rules', import.meta.url).pathname;
const env = await initializeTestEnvironment({
  projectId: 'demo-mcgheelab-mtg',
  firestore: { rules: readFileSync(RULES, 'utf8'), host: '127.0.0.1', port: 8199 }
});

let ok = 0, holes = 0, breaks = 0;
async function mustAllow(name, fn) {
  try { await fn(); console.log('  ok    ' + name); ok++; }
  catch (e) { console.log('  BREAK ' + name + '  — ' + (e.code || e.message)); breaks++; }
}
async function mustDeny(name, fn) {
  try { await fn(); console.log('  HOLE  ' + name); holes++; }
  catch (e) { console.log('  ok    ' + name); ok++; }
}

/* ── personas ── */
const admin = env.authenticatedContext('admin').firestore();
const coord = env.authenticatedContext('coord').firestore();   // Cason: editor + coordinatorUids
const gabe  = env.authenticatedContext('gabe').firestore();    // member, presenter of mtg-a
const zeke  = env.authenticatedContext('zeke').firestore();    // member, presenter of mtg-b
const ally  = env.authenticatedContext('ally').firestore();    // member, party to nothing
const guest = env.authenticatedContext('guest').firestore();

const MTG_A = {
  date: '2026-09-11', time: '11:00', duration: 60, location: 'BSRL 100',
  status: 'upcoming', kind: 'standard',
  presenters: { gabe: { slot: 0, name: 'Gabe', title: '', abstract: '', link: null } },
  updates: { submissions: {}, deck: null, review: { status: null } },
  agendaItems: [{ id: 'ag1', text: 'Lab business', minutes: 10, type: 'business', order: 0, done: false }],
  minutes: { text: '', items: {} }, actionItems: [], feedback: [],
};
const MTG_B = Object.assign({}, MTG_A, {
  date: '2026-09-18',
  presenters: { zeke: { slot: 0, name: 'Zeke', title: '', abstract: '', link: null } },
});
const MTG_EMPTY = Object.assign({}, MTG_A, { date: '2026-10-02', presenters: {} });

async function seed() {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const d = ctx.firestore();
    await setDoc(doc(d, 'users/admin'), { role: 'admin', category: 'pi' });
    await setDoc(doc(d, 'users/coord'), { role: 'editor', category: 'grad' });
    await setDoc(doc(d, 'users/gabe'),  { role: 'editor', category: 'grad' });
    await setDoc(doc(d, 'users/zeke'),  { role: 'contributor', category: 'undergrad', mentor_uids: ['coord'] });
    await setDoc(doc(d, 'users/ally'),  { role: 'contributor', category: 'undergrad' });
    await setDoc(doc(d, 'users/guest'), { role: 'guest' });
    await setDoc(doc(d, 'meetingConfig/settings'), {
      defaultDay: 5, defaultTime: '11:00', defaultLocation: 'BSRL 100',
      coordinatorUids: ['coord'], primaryCoordinatorUid: 'coord', reviewerUids: ['admin'],
    });
    await setDoc(doc(d, 'meetings/mtg-a'), MTG_A);
    await setDoc(doc(d, 'meetings/mtg-b'), MTG_B);
    await setDoc(doc(d, 'meetings/mtg-empty'), MTG_EMPTY);
    await setDoc(doc(d, 'meetingTopics/t1'), {
      text: 'Confocal tips', suggestedBy: 'zeke', suggestedByName: 'Zeke', votes: ['zeke'], status: 'open',
    });
    await setDoc(doc(d, 'meetingSwaps/s1'), {
      fromUid: 'gabe', fromMeetingId: 'mtg-a', fromSlot: 0,
      toUid: 'zeke', toMeetingId: 'mtg-b', toSlot: 0, status: 'pending',
    });
    await setDoc(doc(d, 'labChores/2026-W37'), {
      weekId: '2026-W37', meetingId: 'mtg-a',
      assignments: {
        autoclave: { uid: 'zeke', name: 'Zeke' },
        mop:       { uid: 'gabe', name: 'Gabe' },
      },
      completions: {},
    });
    // V3.938 — one-on-one slots: the PI's two open times, Cason's time booked by
    // his mentee Zeke, and one the PI ended.
    await setDoc(doc(d, 'oneOnOneSlots/oo-open'),   SLOT({ hostUid: 'admin', hostName: 'Alex' }));
    await setDoc(doc(d, 'oneOnOneSlots/oo-open2'),  SLOT({ hostUid: 'admin', hostName: 'Alex' }));
    await setDoc(doc(d, 'oneOnOneSlots/oo-booked'), SLOT({ hostUid: 'coord', hostName: 'Cason', subscriberUid: 'zeke', subscriberName: 'Zeke', subscribedBy: 'self', subscribedAt: '2026-10-29T00:00:00Z' }));
    await setDoc(doc(d, 'oneOnOneSlots/oo-ended'),  SLOT({ hostUid: 'admin', hostName: 'Alex', active: false }));
  });
}
function SLOT(extra) {
  return Object.assign({
    weekday: 2, time: '14:00', duration: 30, cadence: 'weekly', location: 'Office', note: '',
    startDate: '2026-11-03', endDate: '2026-12-18', active: true,
    subscriberUid: null, subscriberName: '', subscribedAt: null, subscribedBy: null, skips: {},
    updatedBy: extra.hostUid, createdBy: extra.hostUid,
  }, extra);
}
await seed();

/* ═══════════ 1. the old hole ═══════════ */
console.log('\n── guests are OUT (pre-V3.743 the block was `request.auth != null`) ──');
await mustDeny ('guest reads a meeting',                 () => getDoc(doc(guest, 'meetings/mtg-a')));
await mustDeny ('guest lists meetings',                  () => getDocs(collection(guest, 'meetings')));
await mustDeny ('guest updates a meeting',               () => updateDoc(doc(guest, 'meetings/mtg-a'), { location: 'hijack' }));
await mustDeny ('guest reads config',                    () => getDoc(doc(guest, 'meetingConfig/settings')));
await mustAllow('member reads a meeting',                () => getDoc(doc(gabe, 'meetings/mtg-a')));
await mustAllow('member lists meetings',                 () => getDocs(collection(gabe, 'meetings')));
await mustAllow('member reads config',                   () => getDoc(doc(gabe, 'meetingConfig/settings')));

/* ═══════════ 2. presenters map — own key only ═══════════ */
console.log('\n── presenters: a member touches ONLY their own key ──');
await mustAllow('gabe edits his own title/abstract',
  () => updateDoc(doc(gabe, 'meetings/mtg-a'), {
    'presenters.gabe.title': 'TFM on soft gels', 'presenters.gabe.abstract': 'x', updatedAt: new Date() }));
await mustAllow('gabe sets his own slides link',
  () => updateDoc(doc(gabe, 'meetings/mtg-a'), {
    'presenters.gabe.link': { url: 'https://drive.google.com/file/d/abc/view', fileId: 'abc', ownerOk: null } }));
await mustDeny ('zeke edits GABE\'s title on mtg-a',
  () => updateDoc(doc(zeke, 'meetings/mtg-a'), { 'presenters.gabe.title': 'hijack' }));
await mustDeny ('zeke removes gabe from mtg-a',
  () => updateDoc(doc(zeke, 'meetings/mtg-a'), { 'presenters.gabe': deleteField() }));
await mustDeny ('zeke adds himself AND removes gabe in one write (a client-side "swap")',
  () => updateDoc(doc(zeke, 'meetings/mtg-a'), {
    'presenters.gabe': deleteField(), 'presenters.zeke': { slot: 0, name: 'Zeke' } }));
await mustAllow('zeke claims an EMPTY slot on mtg-empty',
  () => updateDoc(doc(zeke, 'meetings/mtg-empty'), {
    'presenters.zeke': { slot: 0, name: 'Zeke', title: '', abstract: '', link: null }, updatedAt: new Date() }));
await mustAllow('zeke releases his own slot on mtg-empty',
  () => updateDoc(doc(zeke, 'meetings/mtg-empty'), { 'presenters.zeke': deleteField() }));
await mustDeny ('gabe writes the whole presenters map (array-era client)',
  () => updateDoc(doc(gabe, 'meetings/mtg-a'), { presenters: { gabe: { slot: 0 }, zeke: { slot: 1 } } }));
await mustAllow('coordinator rewrites presenters wholesale',
  () => updateDoc(doc(coord, 'meetings/mtg-a'), {
    presenters: { gabe: { slot: 0, name: 'Gabe' }, zeke: { slot: 1, name: 'Zeke' } } }));
await mustAllow('admin rewrites presenters wholesale',
  () => updateDoc(doc(admin, 'meetings/mtg-a'), {
    presenters: { gabe: { slot: 0, name: 'Gabe' } } }));

/* ═══════════ 3. collaborative fields vs structural fields ═══════════ */
console.log('\n── members write the collaborative fields, not the structure ──');
await mustAllow('member writes per-item minutes (dotted path)',
  () => updateDoc(doc(zeke, 'meetings/mtg-a'), {
    'minutes.items.ag1.notes': 'we discussed X', 'minutes.items.ag1.done': true,
    'minutes.updatedAt': new Date(), 'minutes.updatedBy': 'zeke' }));
await mustAllow('member writes general minutes text',
  () => updateDoc(doc(zeke, 'meetings/mtg-a'), { 'minutes.text': 'general', updatedAt: new Date() }));
await mustAllow('member adds an action item',
  () => updateDoc(doc(zeke, 'meetings/mtg-a'), {
    actionItems: [{ id: 'ai1', text: 'order gels', assigneeUid: 'gabe', status: 'open' }], updatedAt: new Date() }));
await mustAllow('member submits their own round-robin slides',
  () => updateDoc(doc(zeke, 'meetings/mtg-a'), {
    'updates.submissions.zeke': { link: { url: 'https://drive.google.com/x', fileId: 'x' }, submittedAt: new Date() } }));
await mustAllow('presenter posts the combined deck',
  () => updateDoc(doc(gabe, 'meetings/mtg-a'), {
    'updates.deck': { url: 'https://drive.google.com/d', fileId: 'd' }, 'updates.deckBy': 'gabe', 'updates.deckAt': new Date() }));
await mustAllow('member reacts (feedback)',
  () => updateDoc(doc(zeke, 'meetings/mtg-a'), {
    feedback: [{ uid: 'zeke', type: 'interesting', createdAt: new Date() }] }));
await mustDeny ('member changes the date',       () => updateDoc(doc(zeke, 'meetings/mtg-a'), { date: '2026-12-25' }));
await mustDeny ('member changes the location',   () => updateDoc(doc(zeke, 'meetings/mtg-a'), { location: 'my desk' }));
await mustDeny ('member changes the kind',       () => updateDoc(doc(zeke, 'meetings/mtg-a'), { kind: 'break' }));
await mustDeny ('member cancels the meeting',    () => updateDoc(doc(zeke, 'meetings/mtg-a'), { status: 'cancelled' }));
await mustDeny ('member edits the agenda structure', () => updateDoc(doc(zeke, 'meetings/mtg-a'), { agendaItems: [] }));
await mustDeny ('member writes minutes AND the date in one update',
  () => updateDoc(doc(zeke, 'meetings/mtg-a'), { 'minutes.text': 'x', date: '2026-12-25' }));
await mustDeny ('member creates a meeting',
  () => setDoc(doc(zeke, 'meetings/rogue'), MTG_EMPTY));
await mustDeny ('member deletes a meeting',      () => deleteDoc(doc(zeke, 'meetings/mtg-empty')));

/* ═══════════ 4. coordinator role is real ═══════════ */
console.log('\n── coordinator: everything except appointing coordinators ──');
await mustAllow('coordinator creates a meeting',
  () => setDoc(doc(coord, 'meetings/mtg-new'), MTG_EMPTY));
await mustAllow('coordinator changes location + agenda',
  () => updateDoc(doc(coord, 'meetings/mtg-a'), { location: 'BSRL 101', agendaItems: [] }));
await mustAllow('coordinator marks complete',
  () => updateDoc(doc(coord, 'meetings/mtg-a'), { status: 'completed' }));
await mustAllow('coordinator deletes a meeting',
  () => deleteDoc(doc(coord, 'meetings/mtg-new')));
await mustAllow('coordinator saves schedule config',
  () => updateDoc(doc(coord, 'meetingConfig/settings'), {
    semesterStart: '2026-09-11', semesterEnd: '2026-12-18', skipWeeks: ['2026-11-23'], updatedAt: new Date() }));
await mustAllow('coordinator edits agenda templates + chore catalogue',
  () => updateDoc(doc(coord, 'meetingConfig/settings'), {
    agendaTemplates: { standard: [] }, chores: [{ id: 'mop', label: 'Mop' }] }));
await mustDeny ('coordinator appoints a coordinator',
  () => updateDoc(doc(coord, 'meetingConfig/settings'), { coordinatorUids: ['coord', 'zeke'] }));
await mustDeny ('coordinator changes the primary coordinator',
  () => updateDoc(doc(coord, 'meetingConfig/settings'), { primaryCoordinatorUid: 'zeke' }));
await mustDeny ('coordinator changes reviewers',
  () => updateDoc(doc(coord, 'meetingConfig/settings'), { reviewerUids: ['coord'] }));
await mustDeny ('coordinator smuggles coordinatorUids alongside a legit field',
  () => updateDoc(doc(coord, 'meetingConfig/settings'), { defaultLocation: 'x', coordinatorUids: ['coord', 'zeke'] }));
await mustAllow('admin appoints a coordinator',
  () => updateDoc(doc(admin, 'meetingConfig/settings'), { coordinatorUids: ['coord', 'gabe'] }));
await mustDeny ('plain member saves config',
  () => updateDoc(doc(zeke, 'meetingConfig/settings'), { defaultLocation: 'x' }));

/* ═══════════ 5. the no-config-doc trap ═══════════ */
console.log('\n── isMeetingCoordinator() with NO config doc: deny, never raise ──');
await env.withSecurityRulesDisabled(async (ctx) => { await deleteDoc(doc(ctx.firestore(), 'meetingConfig/settings')); });
await mustAllow('admin still creates a meeting with no config doc (the || chain is not poisoned)',
  () => setDoc(doc(admin, 'meetings/mtg-noconf'), MTG_EMPTY));
await mustDeny ('ex-coordinator cannot create with no config doc',
  () => setDoc(doc(coord, 'meetings/mtg-noconf2'), MTG_EMPTY));
await mustAllow('member still edits their own presenter key with no config doc',
  () => updateDoc(doc(gabe, 'meetings/mtg-b'), { 'presenters.gabe': { slot: 1, name: 'Gabe' } }));
await mustAllow('admin CREATES the config doc (resource == null path)',
  () => setDoc(doc(admin, 'meetingConfig/settings'), { coordinatorUids: ['coord'], defaultDay: 5 }));
await seed();

/* ═══════════ 6. topics ═══════════ */
console.log('\n── topics: anyone votes, author/coordinator edit ──');
await mustAllow('member suggests a topic',
  () => setDoc(doc(gabe, 'meetingTopics/t2'), { text: 'Hydrogel QC', suggestedBy: 'gabe', votes: [], status: 'open' }));
await mustDeny ('member suggests a topic AS someone else',
  () => setDoc(doc(gabe, 'meetingTopics/t3'), { text: 'x', suggestedBy: 'zeke', votes: [], status: 'open' }));
await mustAllow('non-author upvotes',
  () => updateDoc(doc(gabe, 'meetingTopics/t1'), { votes: ['zeke', 'gabe'], updatedAt: new Date() }));
await mustDeny ('non-author edits the text',
  () => updateDoc(doc(gabe, 'meetingTopics/t1'), { text: 'vandalised' }));
await mustDeny ('non-author votes AND edits text',
  () => updateDoc(doc(gabe, 'meetingTopics/t1'), { votes: ['gabe'], text: 'vandalised' }));
await mustDeny ('non-author schedules it',
  () => updateDoc(doc(gabe, 'meetingTopics/t1'), { status: 'scheduled', meetingId: 'mtg-a' }));
await mustAllow('author edits own text',
  () => updateDoc(doc(zeke, 'meetingTopics/t1'), { text: 'Confocal tips (updated)' }));
await mustAllow('coordinator schedules it into a meeting',
  () => updateDoc(doc(coord, 'meetingTopics/t1'), { status: 'scheduled', meetingId: 'mtg-a', agendaItemId: 'ag9' }));
await mustAllow('author withdraws own topic',        () => deleteDoc(doc(gabe, 'meetingTopics/t2')));
await mustDeny ('non-author deletes a topic',        () => deleteDoc(doc(gabe, 'meetingTopics/t1')));
await mustDeny ('guest suggests a topic',
  () => setDoc(doc(guest, 'meetingTopics/t4'), { text: 'x', suggestedBy: 'guest', votes: [], status: 'open' }));

/* ═══════════ 7. swaps ═══════════ */
console.log('\n── swaps: target accepts/declines, requester cancels, nobody else ──');
await mustAllow('requester creates a pending swap',
  () => setDoc(doc(gabe, 'meetingSwaps/s2'), {
    fromUid: 'gabe', fromMeetingId: 'mtg-a', fromSlot: 0, toUid: 'zeke', toMeetingId: 'mtg-b', toSlot: 0, status: 'pending' }));
await mustDeny ('requester creates it pre-accepted',
  () => setDoc(doc(gabe, 'meetingSwaps/s3'), {
    fromUid: 'gabe', fromMeetingId: 'mtg-a', fromSlot: 0, toUid: 'zeke', toMeetingId: 'mtg-b', toSlot: 0, status: 'accepted' }));
await mustDeny ('someone creates a swap on gabe\'s behalf',
  () => setDoc(doc(zeke, 'meetingSwaps/s4'), {
    fromUid: 'gabe', fromMeetingId: 'mtg-a', fromSlot: 0, toUid: 'zeke', toMeetingId: 'mtg-b', toSlot: 0, status: 'pending' }));
await mustAllow('target accepts',      () => updateDoc(doc(zeke, 'meetingSwaps/s1'), { status: 'accepted', resolvedAt: new Date() }));
await seed();
await mustAllow('target declines',     () => updateDoc(doc(zeke, 'meetingSwaps/s1'), { status: 'declined', resolvedAt: new Date() }));
await seed();
await mustDeny ('target "cancels" (not their verb)', () => updateDoc(doc(zeke, 'meetingSwaps/s1'), { status: 'cancelled' }));
await mustDeny ('requester accepts his own request',  () => updateDoc(doc(gabe, 'meetingSwaps/s1'), { status: 'accepted' }));
await mustAllow('requester cancels',                  () => updateDoc(doc(gabe, 'meetingSwaps/s1'), { status: 'cancelled' }));
await seed();
await mustDeny ('third party (a member, not a party) accepts', () => updateDoc(doc(ally, 'meetingSwaps/s1'), { status: 'accepted' }));
await mustDeny ('third party declines',               () => updateDoc(doc(ally, 'meetingSwaps/s1'), { status: 'declined' }));
await mustAllow('coordinator force-resolves',         () => updateDoc(doc(coord, 'meetingSwaps/s1'), { status: 'declined' }));
await mustDeny ('member deletes a swap',              () => deleteDoc(doc(gabe, 'meetingSwaps/s1')));
await mustAllow('coordinator deletes a swap',         () => deleteDoc(doc(coord, 'meetingSwaps/s1')));

/* ═══════════ 8. chores ═══════════ */
console.log('\n── chores: coordinator owns assignments, each member owns their own completions key ──');
await seed();
await mustAllow('coordinator creates a week board',
  () => setDoc(doc(coord, 'labChores/2026-W38'), { weekId: '2026-W38', assignments: {}, completions: {} }));
await mustAllow('coordinator rewrites the whole board',
  () => updateDoc(doc(coord, 'labChores/2026-W37'), {
    assignments: { autoclave: { uid: 'gabe' }, mop: { uid: 'zeke' }, sweep: { uid: 'zeke' } } }));
await seed();
await mustAllow('member ticks their own chore done (completions.<me>)',
  () => updateDoc(doc(zeke, 'labChores/2026-W37'), {
    'completions.zeke.autoclave': { doneAt: new Date() }, updatedAt: new Date() }));
await mustAllow('member un-ticks their own chore',
  () => updateDoc(doc(zeke, 'labChores/2026-W37'), { 'completions.zeke.autoclave': deleteField() }));
await mustDeny ('member ticks a chore as SOMEONE ELSE (completions.<other>)',
  () => updateDoc(doc(zeke, 'labChores/2026-W37'), { 'completions.gabe.mop': { doneAt: new Date() } }));
await mustDeny ('member ticks own AND someone else\'s in one write',
  () => updateDoc(doc(zeke, 'labChores/2026-W37'), {
    'completions.zeke.autoclave': { doneAt: new Date() }, 'completions.gabe.mop': { doneAt: new Date() } }));
await mustDeny ('member reassigns a chore (touches assignments)',
  () => updateDoc(doc(zeke, 'labChores/2026-W37'), { 'assignments.mop': { uid: 'ally', name: 'Ally' } }));
await mustDeny ('member rewrites the whole board',
  () => updateDoc(doc(zeke, 'labChores/2026-W37'), { assignments: { autoclave: { uid: 'gabe' } } }));
await mustDeny ('member changes the weekId',
  () => updateDoc(doc(zeke, 'labChores/2026-W37'), { weekId: '2026-W99' }));
await mustDeny ('member creates a week board',
  () => setDoc(doc(zeke, 'labChores/2026-W40'), { weekId: '2026-W40', assignments: {} }));
await mustDeny ('member deletes a week board',      () => deleteDoc(doc(zeke, 'labChores/2026-W37')));
await mustDeny ('guest reads the board',            () => getDoc(doc(guest, 'labChores/2026-W37')));
await mustAllow('member reads the board',           () => getDoc(doc(gabe, 'labChores/2026-W37')));

/* ═══════════ 9. the swap function's batch, as the Admin SDK would do it ═══════════ */
console.log('\n── sanity: the server-side swap batch is what a client CANNOT do ──');
await seed();
await mustDeny('accepting student writes both presenter keys across two meetings (client swap)', async () => {
  const b = writeBatch(zeke);
  b.update(doc(zeke, 'meetings/mtg-a'), { 'presenters.gabe': deleteField(), 'presenters.zeke': { slot: 0, name: 'Zeke' } });
  b.update(doc(zeke, 'meetings/mtg-b'), { 'presenters.zeke': deleteField(), 'presenters.gabe': { slot: 0, name: 'Gabe' } });
  b.update(doc(zeke, 'meetingSwaps/s1'), { status: 'accepted' });
  await b.commit();
});

/* ═══════════ 10. one-on-ones (V3.938) — the student writes only their own uid ═══════════ */
console.log('\n── one-on-ones: claim an open slot for YOURSELF, release / skip your own, the host does the rest ──');
await seed();
const CLAIM = (uid) => ({ subscriberUid: uid, subscriberName: uid, subscribedAt: '2026-10-29T00:00:00Z', subscribedBy: 'self', updatedBy: uid, updatedAt: new Date() });
await mustDeny ('guest reads a slot',                       () => getDoc(doc(guest, 'oneOnOneSlots/oo-open')));
await mustAllow('member reads a slot',                      () => getDoc(doc(gabe, 'oneOnOneSlots/oo-open')));
await mustAllow('member lists slots',                       () => getDocs(collection(gabe, 'oneOnOneSlots')));
await mustAllow('a member offers a time as THEMSELF (hostUid = own uid)',
  () => setDoc(doc(gabe, 'oneOnOneSlots/oo-gabe'), SLOT({ hostUid: 'gabe', hostName: 'Gabe' })));
await mustDeny ('a member creates a slot in the PI\'s name',
  () => setDoc(doc(gabe, 'oneOnOneSlots/oo-fake'), SLOT({ hostUid: 'admin', hostName: 'Alex' })));
await mustDeny ('guest offers a time',
  () => setDoc(doc(guest, 'oneOnOneSlots/oo-guest'), SLOT({ hostUid: 'guest' })));
await mustAllow('zeke claims an open PI slot for himself',
  () => updateDoc(doc(zeke, 'oneOnOneSlots/oo-open'), CLAIM('zeke')));
await mustDeny ('ally claims the slot zeke just took',
  () => updateDoc(doc(ally, 'oneOnOneSlots/oo-open'), CLAIM('ally')));
await mustDeny ('ally puts ZEKE on an open slot (claim for someone else)',
  () => updateDoc(doc(ally, 'oneOnOneSlots/oo-open2'), CLAIM('zeke')));
await mustDeny ('zeke claims an ENDED slot',
  () => updateDoc(doc(zeke, 'oneOnOneSlots/oo-ended'), CLAIM('zeke')));
await mustDeny ('zeke claims a slot AND moves its time in the same write',
  () => updateDoc(doc(zeke, 'oneOnOneSlots/oo-open2'), Object.assign(CLAIM('zeke'), { time: '09:00' })));
await mustAllow('the subscriber marks a week skipped on his own slot',
  () => updateDoc(doc(zeke, 'oneOnOneSlots/oo-booked'), { 'skips.2026-11-10': { by: 'zeke', name: 'Zeke', reason: 'conference', at: 'x' }, updatedBy: 'zeke', updatedAt: new Date() }));
await mustAllow('the subscriber un-skips it',
  () => updateDoc(doc(zeke, 'oneOnOneSlots/oo-booked'), { 'skips.2026-11-10': deleteField(), updatedBy: 'zeke', updatedAt: new Date() }));
await mustDeny ('a bystander writes a skip on someone else\'s slot',
  () => updateDoc(doc(ally, 'oneOnOneSlots/oo-booked'), { 'skips.2026-11-10': { by: 'ally' }, updatedBy: 'ally' }));
await mustDeny ('a bystander writes a skip on an OPEN slot',
  () => updateDoc(doc(ally, 'oneOnOneSlots/oo-open2'), { 'skips.2026-11-10': { by: 'ally' }, updatedBy: 'ally' }));
await mustDeny ('the subscriber moves the time',
  () => updateDoc(doc(zeke, 'oneOnOneSlots/oo-booked'), { time: '15:00', updatedBy: 'zeke' }));
await mustDeny ('the subscriber ends the slot',
  () => updateDoc(doc(zeke, 'oneOnOneSlots/oo-booked'), { active: false, updatedBy: 'zeke' }));
await mustDeny ('the subscriber hands the slot to ally',
  () => updateDoc(doc(zeke, 'oneOnOneSlots/oo-booked'), CLAIM('ally')));
await mustDeny ('the subscriber deletes the slot',
  () => deleteDoc(doc(zeke, 'oneOnOneSlots/oo-booked')));
await mustDeny ('the subscriber stamps the reminder field (function-only)',
  () => updateDoc(doc(zeke, 'oneOnOneSlots/oo-booked'), { lastReminded: '2026-11-10', updatedBy: 'zeke' }));
await mustAllow('the subscriber releases his slot',
  () => updateDoc(doc(zeke, 'oneOnOneSlots/oo-booked'), { subscriberUid: null, subscriberName: '', subscribedAt: null, subscribedBy: null, updatedBy: 'zeke', updatedAt: new Date() }));
await mustAllow('the host (a non-admin mentor) reserves his slot for ally',
  () => updateDoc(doc(coord, 'oneOnOneSlots/oo-booked'), { subscriberUid: 'ally', subscriberName: 'Ally', subscribedBy: 'host', subscribedAt: 'x', updatedBy: 'coord', updatedAt: new Date() }));
await mustAllow('the host moves the time',
  () => updateDoc(doc(coord, 'oneOnOneSlots/oo-booked'), { time: '15:00', weekday: 3, updatedBy: 'coord', updatedAt: new Date() }));
await mustAllow('the host ends it',
  () => updateDoc(doc(coord, 'oneOnOneSlots/oo-booked'), { active: false, endDate: '2026-10-29', updatedBy: 'coord', updatedAt: new Date() }));
await mustDeny ('the host (coordinator, not admin) edits the PI\'s slot',
  () => updateDoc(doc(coord, 'oneOnOneSlots/oo-open2'), { time: '09:00', updatedBy: 'coord' }));
await mustDeny ('a member deletes the PI\'s slot',
  () => deleteDoc(doc(gabe, 'oneOnOneSlots/oo-open2')));
await mustAllow('the host deletes his own slot',
  () => deleteDoc(doc(coord, 'oneOnOneSlots/oo-booked')));
await mustAllow('admin rewrites anyone\'s slot',
  () => updateDoc(doc(admin, 'oneOnOneSlots/oo-gabe'), { subscriberUid: 'zeke', time: '10:00', updatedBy: 'admin' }));
await mustAllow('admin deletes anyone\'s slot',
  () => deleteDoc(doc(admin, 'oneOnOneSlots/oo-gabe')));

console.log(`\nMeetings rules — ${ok} ok, ${holes} HOLE, ${breaks} BREAK`);
await env.cleanup();
process.exit(holes + breaks ? 1 : 0);
