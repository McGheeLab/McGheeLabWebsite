/* V3.851 — researchFoci proposal rules test.
 *
 * What this pins down:
 *   1. A lab member may CREATE a card only as a proposal in their own name
 *      (created_by + approval.proposed_by == uid, status 'proposed',
 *      published false). Any other shape from a non-admin is denied.
 *   2. While a card is proposed/declined: the proposer edits it and may
 *      re-propose after a decline, but can never write a decision; the
 *      proposer's MENTOR (users/{proposer}.mentor_uids) edits it and decides
 *      it in their own name only; an unrelated member can do nothing.
 *   3. Once approved, the card is admin-write — the proposer and the mentor
 *      are locked out, exactly like every pre-V3.851 card.
 *   4. A LEGACY card (no `approval` key) reads as approved: a non-admin
 *      write to it is DENIED, not an error (the status lookup is
 *      resource-free, so isMentorOf() is never reached on that path).
 *   5. `published` can never be set true by a non-admin.
 *   6. Delete: proposer or mentor while undecided; admin always; nobody else.
 *
 * Setup + run (same harness as meetings-rules.test.mjs):
 *   cd scripts/tests
 *   JAVA_HOME=/opt/homebrew/opt/openjdk@21 PATH=$JAVA_HOME/bin:$PATH \
 *     firebase emulators:exec --only firestore --project demo-mcgheelab-rf \
 *     "node research-foci-rules.test.mjs"
 *   RULES=/abs/path/to/other.rules … runs the same cases against another file
 *   (used to prove the scratch LIVE+block deploy copy before shipping it).
 *
 * Output marks: ok / HOLE (allowed, should deny) / BREAK (denied, should allow).
 */
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { readFileSync } from 'node:fs';
import { doc, setDoc, getDoc, getDocs, updateDoc, deleteDoc, collection, setLogLevel } from 'firebase/firestore';

setLogLevel('silent');

const RULES = process.env.RULES || new URL('../../firestore.rules', import.meta.url).pathname;
console.log('rules file: ' + RULES);
const env = await initializeTestEnvironment({
  projectId: 'demo-mcgheelab-rf',
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
const admin  = env.authenticatedContext('admin').firestore();
const mentor = env.authenticatedContext('mentor').firestore();  // advisor of stu
const stu    = env.authenticatedContext('stu').firestore();     // grad student, proposer
const other  = env.authenticatedContext('other').firestore();   // member, not stu's mentor
const guest  = env.authenticatedContext('guest').firestore();

const proposal = (overrides = {}) => Object.assign({
  level: 'aim', title: 'Void space over time', created_by: 'stu',
  approval: { status: 'proposed', proposed_by: 'stu', proposed_at: '2026-10-23T00:00:00Z' },
  published: false, member_uids: ['stu'], links: { grant_ids: ['career'] },
}, overrides);

async function seed() {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const d = ctx.firestore();
    await setDoc(doc(d, 'users/admin'),  { role: 'admin', category: 'pi' });
    await setDoc(doc(d, 'users/mentor'), { role: 'editor', category: 'postdoc' });
    await setDoc(doc(d, 'users/stu'),    { role: 'editor', category: 'grad', mentor_uids: ['mentor'] });
    await setDoc(doc(d, 'users/other'),  { role: 'editor', category: 'grad' });
    await setDoc(doc(d, 'users/guest'),  { role: 'guest' });
    // legacy PI-authored card: no approval key at all
    await setDoc(doc(d, 'researchFoci/career'), { level: 'grant', title: 'CAREER', created_by: 'admin', published: false });
    // an open proposal by stu, a declined one, and an approved one
    await setDoc(doc(d, 'researchFoci/rf-open'), proposal());
    await setDoc(doc(d, 'researchFoci/rf-declined'), proposal({
      approval: { status: 'declined', proposed_by: 'stu', decided_by: 'mentor', note: 'too broad' } }));
    await setDoc(doc(d, 'researchFoci/rf-approved'), proposal({
      approval: { status: 'approved', proposed_by: 'stu', decided_by: 'mentor' } }));
  });
}
await seed();

/* ═══════════ 0. reads unchanged ═══════════ */
console.log('\n── reads: members yes, guests no ──');
await mustAllow('member lists the map',          () => getDocs(collection(stu, 'researchFoci')));
await mustAllow('other member reads a proposal', () => getDoc(doc(other, 'researchFoci/rf-open')));
await mustDeny ('guest reads a card',            () => getDoc(doc(guest, 'researchFoci/career')));

/* ═══════════ 1. create ═══════════ */
console.log('\n── create: a member may only PROPOSE, in their own name ──');
await mustAllow('stu proposes a card',
  () => setDoc(doc(stu, 'researchFoci/rf-new'), proposal()));
await mustAllow('other member proposes too (any member may propose)',
  () => setDoc(doc(other, 'researchFoci/rf-other'), proposal({ created_by: 'other', member_uids: ['other'],
    approval: { status: 'proposed', proposed_by: 'other' } })));
await mustDeny ('stu creates an APPROVED card',
  () => setDoc(doc(stu, 'researchFoci/rf-x1'), proposal({ approval: { status: 'approved', proposed_by: 'stu' } })));
await mustDeny ('stu creates a card with NO approval key (legacy shape)',
  () => setDoc(doc(stu, 'researchFoci/rf-x2'), { level: 'aim', title: 'x', created_by: 'stu', published: false }));
await mustDeny ('stu proposes in MENTOR\'s name (created_by)',
  () => setDoc(doc(stu, 'researchFoci/rf-x3'), proposal({ created_by: 'mentor' })));
await mustDeny ('stu proposes in MENTOR\'s name (proposed_by)',
  () => setDoc(doc(stu, 'researchFoci/rf-x4'), proposal({ approval: { status: 'proposed', proposed_by: 'mentor' } })));
await mustDeny ('stu proposes a PUBLISHED card',
  () => setDoc(doc(stu, 'researchFoci/rf-x5'), proposal({ published: true })));
await mustDeny ('guest proposes',
  () => setDoc(doc(guest, 'researchFoci/rf-x6'), proposal({ created_by: 'guest', approval: { status: 'proposed', proposed_by: 'guest' } })));
await mustAllow('admin creates a plain card (no approval key), as before',
  () => setDoc(doc(admin, 'researchFoci/tfm'), { level: 'specialty', title: 'TFM', created_by: 'admin', published: false }));

/* ═══════════ 2. the proposer while open ═══════════ */
console.log('\n── proposer: edit yes, decide never, publish never ──');
await mustAllow('stu edits own open proposal (title)',
  () => updateDoc(doc(stu, 'researchFoci/rf-open'), { title: 'Void fraction over time', updated_by: 'stu' }));
await mustAllow('stu rewrites approval but keeps it proposed in own name',
  () => updateDoc(doc(stu, 'researchFoci/rf-open'), { approval: { status: 'proposed', proposed_by: 'stu', proposed_at: 'later' } }));
await mustDeny ('stu APPROVES own proposal',
  () => updateDoc(doc(stu, 'researchFoci/rf-open'), { approval: { status: 'approved', proposed_by: 'stu', decided_by: 'stu' } }));
await mustDeny ('stu approves own proposal via dotted path',
  () => updateDoc(doc(stu, 'researchFoci/rf-open'), { 'approval.status': 'approved' }));
await mustDeny ('stu removes the approval key (would read as approved)',
  () => updateDoc(doc(stu, 'researchFoci/rf-open'), { approval: null }));
await mustDeny ('stu publishes own proposal',
  () => updateDoc(doc(stu, 'researchFoci/rf-open'), { published: true }));
await mustDeny ('stu hands the card to someone else (created_by)',
  () => updateDoc(doc(stu, 'researchFoci/rf-open'), { created_by: 'mentor' }));
await mustDeny ('stu re-proposes in MENTOR\'s name',
  () => updateDoc(doc(stu, 'researchFoci/rf-open'), { approval: { status: 'proposed', proposed_by: 'mentor' } }));

/* ═══════════ 3. an unrelated member ═══════════ */
console.log('\n── unrelated member: nothing ──');
await mustDeny ('other edits stu\'s proposal',
  () => updateDoc(doc(other, 'researchFoci/rf-open'), { title: 'hijack' }));
await mustDeny ('other approves stu\'s proposal in own name',
  () => updateDoc(doc(other, 'researchFoci/rf-open'), { approval: { status: 'approved', proposed_by: 'stu', decided_by: 'other' } }));
await mustDeny ('other deletes stu\'s proposal',
  () => deleteDoc(doc(other, 'researchFoci/rf-open')));

/* ═══════════ 4. the mentor ═══════════ */
console.log('\n── mentor: edit while open, decide in own name ──');
await mustAllow('mentor edits mentee\'s open proposal (one_liner)',
  () => updateDoc(doc(mentor, 'researchFoci/rf-open'), { one_liner: 'tightened', updated_by: 'mentor' }));
await mustDeny ('mentor approves in ADMIN\'s name',
  () => updateDoc(doc(mentor, 'researchFoci/rf-open'), { approval: { status: 'approved', proposed_by: 'stu', decided_by: 'admin' } }));
await mustDeny ('mentor approves with no decided_by',
  () => updateDoc(doc(mentor, 'researchFoci/rf-open'), { approval: { status: 'approved', proposed_by: 'stu' } }));
await mustDeny ('mentor rewrites proposed_by while editing',
  () => updateDoc(doc(mentor, 'researchFoci/rf-open'), { approval: { status: 'proposed', proposed_by: 'mentor' } }));
await mustDeny ('mentor publishes',
  () => updateDoc(doc(mentor, 'researchFoci/rf-open'), { published: true }));
await mustAllow('mentor DECLINES in own name with a note',
  () => updateDoc(doc(mentor, 'researchFoci/rf-open'), { approval: { status: 'declined', proposed_by: 'stu', decided_by: 'mentor', note: 'scope it to one grant' } }));
await mustAllow('stu re-proposes after the decline',
  () => updateDoc(doc(stu, 'researchFoci/rf-open'), { approval: { status: 'proposed', proposed_by: 'stu', proposed_at: 'again', previous_note: 'scope it to one grant' } }));
await mustDeny ('stu turns a decline into an approval',
  () => updateDoc(doc(stu, 'researchFoci/rf-declined'), { approval: { status: 'approved', proposed_by: 'stu', decided_by: 'stu' } }));
await mustAllow('mentor APPROVES in own name',
  () => updateDoc(doc(mentor, 'researchFoci/rf-open'), { approval: { status: 'approved', proposed_by: 'stu', decided_by: 'mentor', decided_at: 'now' } }));

/* ═══════════ 5. after approval: admin-write ═══════════ */
console.log('\n── approved: admin only, like every pre-V3.851 card ──');
await mustDeny ('stu edits own APPROVED card',
  () => updateDoc(doc(stu, 'researchFoci/rf-approved'), { title: 'x' }));
await mustDeny ('mentor edits mentee\'s APPROVED card',
  () => updateDoc(doc(mentor, 'researchFoci/rf-approved'), { title: 'x' }));
await mustDeny ('mentor un-approves back to proposed',
  () => updateDoc(doc(mentor, 'researchFoci/rf-approved'), { approval: { status: 'proposed', proposed_by: 'stu' } }));
await mustAllow('admin edits the approved card',
  () => updateDoc(doc(admin, 'researchFoci/rf-approved'), { title: 'x', published: true }));
await mustDeny ('stu deletes own approved card',
  () => deleteDoc(doc(stu, 'researchFoci/rf-approved')));

/* ═══════════ 6. legacy cards ═══════════ */
console.log('\n── legacy card (no approval key) reads as approved; a non-admin write is DENIED, not an error ──');
await mustDeny ('stu edits the legacy CAREER card',
  () => updateDoc(doc(stu, 'researchFoci/career'), { title: 'x' }));
await mustDeny ('mentor edits the legacy CAREER card',
  () => updateDoc(doc(mentor, 'researchFoci/career'), { title: 'x' }));
await mustDeny ('stu "proposes" over the legacy card to capture it',
  () => updateDoc(doc(stu, 'researchFoci/career'), { created_by: 'stu', approval: { status: 'proposed', proposed_by: 'stu' } }));
await mustDeny ('stu deletes the legacy card',
  () => deleteDoc(doc(stu, 'researchFoci/career')));
await mustAllow('admin edits the legacy card',
  () => updateDoc(doc(admin, 'researchFoci/career'), { title: 'CAREER 2026' }));

/* ═══════════ 7. delete while undecided ═══════════ */
console.log('\n── delete: proposer or mentor while undecided ──');
await mustAllow('stu withdraws own declined proposal',
  () => deleteDoc(doc(stu, 'researchFoci/rf-declined')));
await mustAllow('mentor deletes mentee\'s open proposal',
  () => deleteDoc(doc(mentor, 'researchFoci/rf-new')));
await mustAllow('admin deletes anything',
  () => deleteDoc(doc(admin, 'researchFoci/rf-other')));

console.log(`\nresearch-foci-rules: ${ok} ok, ${holes} HOLE, ${breaks} BREAK`);
await env.cleanup();
process.exit(holes + breaks ? 1 : 0);
