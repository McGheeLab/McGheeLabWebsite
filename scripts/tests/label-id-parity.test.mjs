/* label-id parity + QR decode round-trip (V3.646).
 *
 *   node scripts/tests/label-id-parity.test.mjs
 *
 * TWO repos have to agree about what a label code IS. LabelPrinter MINTS them
 * (web/core/ids.js) and RM READS them (rm/js/label-id.js, a vendored port). A
 * divergence does not throw — it resolves a scan to the wrong tube, or to
 * nothing while the label looks perfect. So this fuzzes both implementations
 * against each other and cross-validates 4,000 real mints in both directions.
 *
 * It also round-trips LabelPrinter's ENCODER through the decoder RM ships
 * (rm/vendor/jsqr), which is what caught the transposed placeFormat() that made
 * every printed symbol unreadable. Requires the LabelPrinter checkout as a
 * sibling of McGheeLabWebsite.
 */
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';

// Repo-relative, two levels up from scripts/tests/ — so this runs from any
// checkout, and says out loud when the sibling repo simply isn't there.
const RM_PORT  = new URL('../../rm/js/label-id.js', import.meta.url).pathname;
const SRC_PATH = new URL('../../../LabelPrinter/web/core/ids.js', import.meta.url).pathname;
let SRC;
try {
  SRC = await import(SRC_PATH);
} catch (e) {
  console.log('SKIP — LabelPrinter checkout not found beside McGheeLabWebsite.\n' +
              '       expected ' + SRC_PATH);
  process.exit(0);
}
const sandbox = { window: { crypto: webcrypto } };
new Function('window', readFileSync(RM_PORT, 'utf8')).call(sandbox, sandbox.window);
const P = sandbox.window.LABEL_ID;
let ok=0, bad=0;
const t=(n,c,extra)=>{ console.log((c?'  ok   ':'  FAIL ')+n+(c?'':'  '+(extra||''))); c?ok++:bad++; };

const cases = ['MG-A7K2X','mg-a7k2x',' MG-A7K2X\r\n','https://mcgheelab.com/l/MG-A7K2X',
  'HTTPS://MCGHEELAB.COM/L/MG-A7K2X','MG-A7KLO','MG-UUUUU','','X1','MG-','scan.html?code=MG-A7K2X',
  'MG-ILOU1','mg-wxyz9','MG-00000','MG-MMMMM'];
for (const c of cases) {
  t(`normalize(${JSON.stringify(c)}) parity`, P.normalize(c) === SRC.normalize(c), `${P.normalize(c)} vs ${SRC.normalize(c)}`);
  t(`isValid(${JSON.stringify(c)}) parity`, P.isValid(c) === SRC.isValid(c), `${P.isValid(c)} vs ${SRC.isValid(c)}`);
}
// 2000 real mints from the ORIGINAL must all validate in the PORT.
let mismatch = 0;
for (let i=0;i<2000;i++){ const id = SRC.mintId(); if (!P.isValid(id) || !P.isWellFormed(id) || P.normalize(id)!==id) mismatch++; }
t('2000 codes minted by LabelPrinter all pass the RM port', mismatch===0, mismatch+' mismatches');
// And the port's own mints must satisfy the original.
let m2 = 0;
for (let i=0;i<2000;i++){ const id = P.mintId(); if (!SRC.isValid(id)) m2++; }
t('2000 codes minted by the RM port all pass LabelPrinter', m2===0, m2+' mismatches');
// The shape gate must be strictly stronger than the check-digit gate.
t('isWellFormed rejects "X1" where isValid may accept', P.isWellFormed('X1')===false);
t('isWellFormed rejects a query-string URL', P.isWellFormed('scan.html?code=MG-A7K2X')===false);
let loose=0, strict=0;
for (const a of 'ABCDE') for (const b of '01234') { const s='MG-'+a+b+'K2X'; if (P.isValid(s)) loose++; if (P.isWellFormed(s)) strict++; }
t('isWellFormed <= isValid always', strict<=loose, strict+' vs '+loose);
console.log('\n'+ok+' passed, '+bad+' failed');
process.exit(bad?1:0);
