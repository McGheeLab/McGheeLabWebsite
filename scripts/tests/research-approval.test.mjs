/* research-approval.test.mjs — V3.851 (students propose, PI / advisor approve)
 *
 *   node scripts/tests/research-approval.test.mjs
 *
 * research-data.js in a vm with a stub firebridge + Firestore, run once per
 * persona (the mentee cache is per page-load). Pins down the CLIENT mirror
 * of the V3.851 rule — what the hub offers and what a write sends:
 *   • a legacy card (no approval key) reads as approved;
 *   • create() by a non-admin stamps the proposal shape whatever was passed
 *     (status proposed, own uid, published false, proposer attached as
 *     lead) and an admin's create writes NO approval key at all;
 *   • mayEdit / mayDecide across proposer / mentor / unrelated / admin;
 *   • update() by an outsider throws a clean error, by the proposer strips
 *     `published`; remove() the same;
 *   • approve / decline / repropose write the approval map in the actor's
 *     own name, and the decline note rides a re-proposal as previous_note.
 */
import fs from 'fs';
import vm from 'vm';

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '\n       ' + detail : '')); }
};
const throws = async (name, fn, re) => {
  try { await fn(); ok(name, false, 'did not throw'); }
  catch (e) { ok(name, !re || re.test(e.message), e.message); }
};

/* ── stub Firestore: one shared store, a log of writes ── */
const store = {}; const writes = [];
const key = (c, id) => c + '/' + id;
const docRef = (c, id) => ({
  get: async () => ({ exists: !!store[key(c, id)], id, data: () => store[key(c, id)] }),
  set: async (d) => { writes.push(['set', key(c, id), d]); store[key(c, id)] = JSON.parse(JSON.stringify(d)); },
  update: async (d) => { writes.push(['update', key(c, id), d]); Object.assign(store[key(c, id)], JSON.parse(JSON.stringify(d))); },
  delete: async () => { writes.push(['delete', key(c, id)]); delete store[key(c, id)]; },
});
const rows = (c, pred) => Object.keys(store).filter((k) => k.startsWith(c + '/') && pred(store[k]))
  .map((k) => ({ id: k.slice(c.length + 1), data: () => store[k] }));
const collRef = (c) => ({
  doc: (id) => docRef(c, id),
  get: async () => ({ docs: rows(c, () => true) }),
  where: (field, op, val) => ({ get: async () => ({ docs: rows(c, (d) => Array.isArray(d[field]) && d[field].includes(val)) }) }),
});

store['users/admin'] = { role: 'admin' };
store['users/mentor'] = { role: 'editor' };
store['users/stu'] = { role: 'editor', mentor_uids: ['mentor'] };
store['users/other'] = { role: 'editor' };
store['researchFoci/career'] = { level: 'grant', title: 'CAREER', created_by: 'admin', published: true };

function load(who) {
  const ctx = {
    window: {}, console, DOMParser: class {}, Node: {},
    firebridge: {
      db: () => ({ collection: collRef }),
      getUser: () => ({ uid: who }),
      isAdmin: () => who === 'admin',
      isLabMember: () => who !== 'guest',
    },
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync('rm/js/research-data.js', 'utf8'), ctx);
  return ctx.window.RESEARCH_DATA;
}
const last = () => writes[writes.length - 1];

/* ── 1. hydrate / status ── */
console.log('\n── status: a legacy card reads as approved ──');
{
  const RD = load('stu');
  const legacy = RD.hydrate({ id: 'career', level: 'grant' });
  ok('legacy card: approval null', legacy.approval === null);
  ok('legacy card: approvalStatus approved', RD.approvalStatus(legacy) === 'approved' && RD.isApproved(legacy));
  const p = RD.hydrate({ id: 'x', level: 'aim', created_by: 'stu', approval: { status: 'proposed', proposed_by: 'stu' } });
  ok('proposed card: isProposed', RD.isProposed(p) && !RD.isApproved(p));
  ok('proposerOf: proposed_by, then created_by', RD.proposerOf(p) === 'stu' && RD.proposerOf(legacy) === undefined || RD.proposerOf(legacy) === null);
}

/* ── 2. create ── */
console.log('\n── create: a member\'s create is a proposal whatever was passed ──');
{
  const RD = load('stu');
  const doc = await RD.create({ level: 'aim', title: 'Void space over time', published: true,
    approval: { status: 'approved', proposed_by: 'admin' }, member_uids: ['mentor'] });
  const w = store['researchFoci/void-space-over-time'];
  ok('written under the slug', !!w);
  ok('approval.status proposed, in own name', w.approval.status === 'proposed' && w.approval.proposed_by === 'stu');
  ok('created_by stu', w.created_by === 'stu');
  ok('published pinned false', w.published === false && w.published_at === null);
  ok('proposer attached as lead; passed members kept', w.member_uids.includes('stu') && w.member_roles.stu === 'lead' && w.member_uids.includes('mentor'));
  ok('returned doc mirrors it', RD.isProposed(doc));
  await throws('duplicate id rejected', () => RD.create({ level: 'aim', title: 'Void space over time' }), /already exists/);
}
{
  const RD = load('admin');
  await RD.create({ level: 'specialty', title: 'TFM' });
  const w = store['researchFoci/tfm'];
  ok('admin create writes NO approval key (legacy shape)', !('approval' in w));
  ok('admin create: no member auto-attach', w.member_uids.length === 0);
}
{
  const RD = load('guest');
  await throws('guest cannot propose', () => RD.create({ level: 'aim', title: 'x' }), /lab members/);
}

/* ── 3. mayEdit / mayDecide ── */
console.log('\n── who may edit, who may decide ──');
const prop = () => load('stu').hydrate(Object.assign({ id: 'void-space-over-time' }, store['researchFoci/void-space-over-time']));
const legacyCard = () => load('stu').hydrate(Object.assign({ id: 'career' }, store['researchFoci/career']));
{
  const RD = load('stu'); await RD.loadMentees();
  ok('proposer edits own proposal', RD.mayEdit(prop()));
  ok('proposer never decides own proposal', !RD.mayDecide(prop()));
  ok('proposer cannot edit a legacy card', !RD.mayEdit(legacyCard()));
  ok('canPropose: lab member', RD.canPropose());
}
{
  const RD = load('mentor'); await RD.loadMentees();
  ok('mentor edits mentee\'s proposal', RD.mayEdit(prop()));
  ok('mentor decides mentee\'s proposal', RD.mayDecide(prop()));
  ok('mentor cannot edit a legacy card', !RD.mayEdit(legacyCard()));
  ok('mentor cannot decide a legacy card', !RD.mayDecide(legacyCard()));
}
{
  const RD = load('mentor');   // mentees NOT loaded yet
  ok('before loadMentees a mentor reads as an outsider (never the reverse)', !RD.mayEdit(prop()) && !RD.mayDecide(prop()));
}
{
  const RD = load('other'); await RD.loadMentees();
  ok('unrelated member: no edit', !RD.mayEdit(prop()));
  ok('unrelated member: no decide', !RD.mayDecide(prop()));
}
{
  const RD = load('admin');
  ok('admin edits anything', RD.mayEdit(prop()) && RD.mayEdit(legacyCard()));
  ok('admin decides an undecided card, not an approved one', RD.mayDecide(prop()) && !RD.mayDecide(legacyCard()));
}

/* ── 4. update / remove guards ── */
console.log('\n── update / remove: clean errors, published stripped ──');
{
  const RD = load('other');
  await throws('outsider update throws a clean error', () => RD.update('void-space-over-time', { title: 'x' }), /proposer, their advisor, or the PI/);
  await throws('outsider remove throws', () => RD.remove('void-space-over-time'), /proposer, their advisor, or the PI/);
  await throws('member update of a legacy card names the PI', () => RD.update('career', { title: 'x' }), /Only the PI/);
}
{
  const RD = load('stu');
  await RD.update('void-space-over-time', { title: 'Void fraction over time', published: true, published_at: 'now' });
  const w = last();
  ok('proposer update went through', w[0] === 'update' && w[2].title === 'Void fraction over time');
  ok('…with published / published_at stripped', !('published' in w[2]) && !('published_at' in w[2]));
  ok('…stamped updated_by', w[2].updated_by === 'stu');
}
{
  const RD = load('admin');
  await RD.update('career', { published: true });
  ok('admin update keeps published', last()[2].published === true);
}

/* ── 5. approve / decline / repropose ── */
console.log('\n── the three approval moves ──');
{
  const RD = load('stu');
  await throws('proposer cannot approve', () => RD.approve(prop()), /advisor/);
  await throws('proposer cannot re-propose an OPEN card', () => RD.repropose(prop()), /declined/);
}
{
  const RD = load('mentor');
  await RD.decline(prop(), '  scope it to one grant ');
  const a = store['researchFoci/void-space-over-time'].approval;
  ok('decline: status declined in mentor\'s name, note trimmed', a.status === 'declined' && a.decided_by === 'mentor' && a.note === 'scope it to one grant' && a.proposed_by === 'stu');
}
{
  const RD = load('other');
  await throws('outsider cannot re-propose', () => RD.repropose(prop()), /proposer/);
}
{
  const RD = load('stu');
  await RD.repropose(prop());
  const a = store['researchFoci/void-space-over-time'].approval;
  ok('repropose: proposed again in own name, note carried as previous_note', a.status === 'proposed' && a.proposed_by === 'stu' && a.previous_note === 'scope it to one grant' && a.reproposed === true && a.decided_by === null);
}
{
  const RD = load('mentor');
  await RD.approve(prop());
  const a = store['researchFoci/void-space-over-time'].approval;
  ok('approve: approved in mentor\'s name', a.status === 'approved' && a.decided_by === 'mentor' && a.proposed_by === 'stu');
}
{
  const RD = load('stu');
  await throws('after approval the proposer is locked out', () => RD.update('void-space-over-time', { title: 'x' }), /Only the PI can edit an approved card/);
  await throws('…and cannot withdraw it', () => RD.remove('void-space-over-time'), /Only the PI/);
}
{
  const RD = load('mentor');
  await throws('after approval the mentor is locked out too', () => RD.update('void-space-over-time', { title: 'x' }), /Only the PI/);
}
{
  // a fresh proposal the proposer withdraws
  const RD = load('stu');
  await RD.create({ level: 'output', title: 'Granule paper' });
  await RD.remove('granule-paper');
  ok('proposer withdraws own open proposal', last()[0] === 'delete' && !store['researchFoci/granule-paper']);
}

console.log(`\nresearch-approval: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
