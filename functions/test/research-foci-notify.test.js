/* ================================================================
   research-foci-notify.test.js — transition logic for
   functions/research-foci-notify.js (V3.851)
       node functions/test/research-foci-notify.test.js

   Pins down, without an emulator, which researchFoci writes are worth a
   notification: a proposal landing (or re-landing after a decline), a
   decision reaching the proposer — and the null transitions: an admin's
   own card (no approval key, or created already approved), an edit that
   leaves the status alone, the notified_status stamp, a delete.
   ================================================================ */
'use strict';
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'test-project';

let I;
try { I = require('../research-foci-notify')._internal; }
catch (e) { console.error('Could not load research-foci-notify.js:', e.message); process.exit(1); }

let pass = 0, fail = 0; const failures = [];
function check(name, cond, detail) { if (cond) { pass++; return; } fail++; failures.push(name + (detail ? '\n      ' + detail : '')); }
const J = JSON.stringify;

const legacy = { level: 'grant', title: 'CAREER', created_by: 'admin' };
const proposed = { level: 'aim', title: 'Void space', created_by: 'stu', approval: { status: 'proposed', proposed_by: 'stu' } };
const approved = Object.assign({}, proposed, { approval: { status: 'approved', proposed_by: 'stu', decided_by: 'mentor' } });
const declined = Object.assign({}, proposed, { approval: { status: 'declined', proposed_by: 'stu', decided_by: 'mentor', note: 'too broad' } });

/* status + proposer */
check('legacy card reads as approved', I.approvalStatus(legacy) === 'approved');
check('empty approval map reads as approved', I.approvalStatus({ approval: {} }) === 'approved');
check('proposed reads as proposed', I.approvalStatus(proposed) === 'proposed');
check('proposer = approval.proposed_by first', I.proposerOf(proposed) === 'stu');
check('proposer falls back to created_by', I.proposerOf(legacy) === 'admin');

/* proposals landing */
check('create as proposed → proposed', J(I.proposalTransition(null, proposed)) === J({ kind: 'proposed', reproposed: false }));
check('declined → proposed = re-proposed', J(I.proposalTransition(declined, proposed)) === J({ kind: 'proposed', reproposed: true }));
check('approved → proposed (admin reopens) notifies deciders, not flagged re-proposed',
  J(I.proposalTransition(approved, proposed)) === J({ kind: 'proposed', reproposed: false }));

/* decisions reaching the proposer */
check('proposed → approved', J(I.proposalTransition(proposed, approved)) === J({ kind: 'approved' }));
check('proposed → declined', J(I.proposalTransition(proposed, declined)) === J({ kind: 'declined' }));
check('declined → approved (advisor changes their mind)', J(I.proposalTransition(declined, approved)) === J({ kind: 'approved' }));

/* null transitions */
check('admin creates a legacy card → null', I.proposalTransition(null, legacy) === null);
check('admin creates a card already approved → null', I.proposalTransition(null, approved) === null);
check('edit that keeps proposed → null', I.proposalTransition(proposed, Object.assign({}, proposed, { title: 'x' })) === null);
check('edit of a legacy card → null', I.proposalTransition(legacy, Object.assign({}, legacy, { title: 'x' })) === null);
check('notified_status stamp on an approved card → null',
  I.proposalTransition(approved, Object.assign({}, approved, { approval: Object.assign({}, approved.approval, { notified_status: 'approved' }) })) === null);
check('delete → null', I.proposalTransition(proposed, null) === null);
check('approved → legacy shape (approval key removed by admin) → null', I.proposalTransition(approved, legacy) === null);

console.log(`research-foci-notify.test.js: ${pass} passed, ${fail} failed`);
if (failures.length) console.log(failures.map((f) => '  FAIL ' + f).join('\n'));
process.exit(fail ? 1 : 0);
