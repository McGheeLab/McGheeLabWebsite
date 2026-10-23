/* V3.710 — the advice register for the learning modules.
 *
 *   node scripts/tests/module-advice.test.mjs
 *
 * Every other check on a learning module asks "is this internally consistent and
 * numerically right?" — MathJax typeset, canvases inked, controls live, the
 * offline model assertions. Cell Culture Lesson 4 passed all of them for several
 * versions while telling students to AUTOCLAVE A CONTAMINATED BATCH OF MEDIUM.
 *
 * So this file pins the other register: a sentence a reader could act on and be
 * worse off for. Two lists per module —
 *
 *   banned[]   a defect that must not come back, with why it was wrong
 *   required[] a correction that must not be quietly dropped
 *
 * It reads the SOURCE, not the DOM, on purpose: a verdict narration renders in
 * one widget state only, so a `body.innerText` scan sees whichever states the
 * page happened to be in. V3.709's DOM canary missed a stale reference for
 * exactly that reason.
 *
 * Add to this file whenever a review turns up bad advice — the entry is the
 * cheapest possible guard against it being written again.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const REGISTER = [
  {
    file: 'modules/cell_culture/04-aliquoting-and-stewardship.html',
    banned: [
      ['autoclave the batch',
       'medium is FILTER-sterilised because it does not survive 121 °C; and sterile ' +
       'or not, the endotoxin the dead bacteria leave is not removed by autoclaving'],
      ['down the sink',
       'contaminated medium is not sink waste, and the module should not teach a ' +
       'disposal route in passing'],
      ['incubator you are opening anyway',
       'that sends a suspected contaminant into the CO2 box next to the cultures — ' +
       'which Lesson 2 establishes is a warm humid box with a fan that distributes ' +
       'whatever grows in it'],
      ['or store colder, or buy smaller',
       'offered unqualified, in a section whose other half is freeze-thaw loss — ' +
       'complete medium and serum-containing solutions are damaged by freezing. ' +
       'Qualified ("if the certificate of analysis says that stock takes freezing") ' +
       'is fine; the bare option is not'],
      ['gels irreversibly above about 10',
       'Corning gives 22-35 °C; 10 °C is the working margin, not the transition'],
      ['cannot really get it wrong',
       'true before §4.1 existed, false after it: 120 aliquots of a $70 bottle is $42 ' +
       'of plastic for under a dollar of contamination saving'],
      ['costs you nothing but a few more tubes',
       'same over-claim — §4.1 prices exactly what those tubes cost'],
      ['endotoxin they left behind',
       'my own over-correction: a paragraph refuting autoclaving argued with a ' +
       'mistake the reader had not made. Alex: "you are putting ideas students never ' +
       'had into their minds." Say what to do, not why the wrong thing is wrong'],
    ],
    /* Pin the INSTRUCTION, never the reasoning behind it. The first version of
       this list guarded three sentences of argument about why autoclaving is
       wrong — which is precisely the text that had to come out. */
    required: [
      ["failed batch is discarded",         'the failure branch the section used to lack'],
      ["biohazardous liquid-waste",         'where a failed batch goes'],
      ["Not in the cell-culture incubator", 'where the sterility check is incubated'],
      ["discarded, every tube of it",       'the failure branch, as a key takeaway'],
    ],
    /* a section reference to ANOTHER lesson keeps its own numbering: "L3 §3.4"
       is legitimate, a bare "§3.4" in this file is a leftover from V3.709. */
    staleSectionRefs: [{ ref: '§3.4', exemptPrefix: /L\d\s$/ }],
  },
];

const results = [];
const check = (name, ok, detail) => results.push({ name, ok, detail: detail || '' });

/* The source is hard-wrapped, so "autoclave the batch" can sit across a line
   break and defeat a literal match — which is exactly how a defect would come
   back. Collapse whitespace on both sides before comparing. */
const flat = t => t.replace(/\s+/g, ' ');

for (const mod of REGISTER) {
  const src = flat(readFileSync(join(ROOT, mod.file), 'utf8'));
  const short = mod.file.split('/').pop();

  for (const [needle, why] of mod.banned)
    check(`${short}: no "${needle}"`, !src.includes(flat(needle)), why);

  for (const [needle, what] of mod.required)
    check(`${short}: keeps ${what}`, src.includes(flat(needle)),
      `expected to find: ${needle}`);

  for (const { ref, exemptPrefix } of mod.staleSectionRefs || []) {
    const hits = [...src.matchAll(new RegExp(`(.{4})${ref.replace('.', '\\.')}`, 'g'))]
      .filter(m => !exemptPrefix.test(m[1]));
    check(`${short}: no stale ${ref}`, hits.length === 0,
      hits.map(m => `…${m[1]}${ref}`).join(' | '));
  }
}

let pass = 0, fail = 0;
for (const r of results) {
  if (r.ok) { pass++; continue; }
  fail++;
  console.log(` FAIL ${r.name}\n        ${r.detail}`);
}
console.log(`\nadvice register: ${results.length} checks · ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
