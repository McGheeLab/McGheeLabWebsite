/* ================================================================
   auth-alias.test.js — decision logic for functions/auth-alias.js
   ================================================================
       node functions/test/auth-alias.test.js

   Pins down, without an emulator, who gets swapped into the primary
   account (V3.806): only a verified Google login whose email is in the
   map. A password account with the same address, an unverified email, or
   any other email must be refused.
   ================================================================ */

'use strict';

process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'test-project';

let I;
try {
  I = require('../auth-alias')._internal;
} catch (e) {
  console.error('Could not load auth-alias.js:', e.message);
  process.exit(1);
}

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = Object.keys(want).every(k => got[k] === want[k]);
  if (ok) { pass++; console.log('  ok    ' + name); }
  else { fail++; console.log('  FAIL  ' + name + '\n        got ' + JSON.stringify(got) + '\n        want ' + JSON.stringify(want)); }
}

const MAP = { 'alias@school.edu': 'PRIMARY' };
const tok = (o) => Object.assign({ uid: 'ALIASUID', email: 'alias@school.edu', email_verified: true,
  firebase: { sign_in_provider: 'google.com' } }, o);

check('verified Google alias → swap to primary', I.resolveAlias(tok({}), MAP), { status: 200, targetUid: 'PRIMARY' });
check('email match is case-insensitive', I.resolveAlias(tok({ email: 'Alias@School.EDU' }), MAP), { status: 200, targetUid: 'PRIMARY' });
check('any other email → 404', I.resolveAlias(tok({ email: 'someone@school.edu' }), MAP), { status: 404 });
check('no email → 404', I.resolveAlias(tok({ email: undefined }), MAP), { status: 404 });
check('password account with the alias email → 403', I.resolveAlias(tok({ firebase: { sign_in_provider: 'password' } }), MAP), { status: 403 });
check('custom-token session (already swapped) → 403', I.resolveAlias(tok({ firebase: { sign_in_provider: 'custom' } }), MAP), { status: 403 });
check('unverified email → 403', I.resolveAlias(tok({ email_verified: false }), MAP), { status: 403 });
check('already the primary uid → 400', I.resolveAlias(tok({ uid: 'PRIMARY' }), MAP), { status: 400 });
check('prototype keys are not aliases', I.resolveAlias(tok({ email: 'constructor' }), MAP), { status: 404 });
check('live map: arizona.edu → gmail uid',
  I.resolveAlias(tok({ email: 'mcgheealex@arizona.edu' }), I.ALIASES), { status: 200, targetUid: 'uAicelwQ5gNQdH1Qc8wqZcJDRZQ2' });

console.log(`\n${pass} ok, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
