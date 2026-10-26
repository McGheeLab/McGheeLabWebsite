// V3.909 — the journal-look contracts the PDF and the Document view share
// (paper-look.js) and the typesetter's TeX rules (paper-typeset.js).
// node scripts/tests/paper-typeset.test.mjs
import fs from 'fs';
import { createRequire } from 'module';
import assert from 'assert';
const require = createRequire(import.meta.url);
const root = new URL('../../', import.meta.url).pathname;
const T = require(root + 'rm/js/paper-typeset.js');
const H = require(root + 'rm/vendor/hyphen/hyph-en-us.js');
const L = require(root + 'rm/js/paper-look.js');
T.setPatterns(H);
let n = 0;
function ok(c, msg) { assert.ok(c, msg); n++; }
function eq(a, b, msg) { assert.deepStrictEqual(a, b, msg); n++; }
const tpl = (id) => JSON.parse(fs.readFileSync(root + 'rm/data/paper-templates/' + id + '.json', 'utf8'));

// ── hyphenation: TeX's en-US patterns, lefthyphenmin 2, righthyphenmin 3
eq(T.hyphenate('quantitative'), ['quan', 'ti', 'ta', 'tive'], 'patterns');
eq(T.hyphenate('generate'), ['gen', 'er', 'ate'], 'patterns 2');
eq(T.hyphenate('table'), ['ta', 'ble'], 'exception list');
eq(T.hyphenate('cell'), ['cell'], 'too short to break');

// ── Knuth–Plass: a box/glue paragraph breaks where TeX would
function words(ws, w, sp) {
  const it = [];
  ws.forEach((x, i) => {
    if (i) it.push({ t: 'glue', w: sp, y: sp / 2, z: sp / 3 });
    it.push({ t: 'box', w: x * w });
  });
  // the paragraph's end, as layoutParagraph writes it: \parfillskip + a forced break
  it.push({ t: 'pen', w: 0, p: 10000 }, { t: 'glue', w: 0, y: 0, z: 0, fil: true }, { t: 'pen', w: 0, p: -10000 });
  return it;
}
{
  const items = words([3, 3, 3, 3, 3, 3, 3, 3], 10, 6);   // 8 words of 30 + spaces of 6
  const r = T.breakLines(items, 100, {});
  ok(r.lines === 3, 'three lines at width 100 (got ' + r.lines + ')');
  ok(!r.overfull, 'no overfull line');
}
{
  // a paragraph that cannot fit without shrinking past the limit is overfull, never dropped
  const r = T.breakLines(words([12, 12], 10, 6), 100, {});
  ok(r.lines >= 1 && r.overfull, 'too-wide word → overfull, still laid out');
}
{
  // V3.917 — a forced break inside the paragraph (a <br>) ends a LINE, not
  // the paragraph: everything after it is still set
  const a = words([3, 3], 10, 6).slice(0, -3), b = words([3, 3, 3], 10, 6);
  const items = a.concat([{ t: 'glue', w: 0, y: 0, z: 0, fil: true }, { t: 'pen', w: 0, p: -10000 }], b);
  const r = T.breakLines(items, 100, {});
  ok(r && r.lines === 2 && r.breaks[1] === items.length - 1, 'br mid-paragraph → 2 lines, the last at the end (got ' + (r && r.lines) + ')');
}

// ── inline math breaks only at top-level relations and binary operators
{
  const parts = T.splitMathSource('a = b + \\frac{c}{d}');
  ok(parts.length === 3, 'a = | b + | frac (got ' + parts.length + ')');
  ok(parts[0].after === 'rel' && parts[1].after === 'bin', 'rel then bin');
  eq(T.splitMathSource('x_{a=b}').length, 1, 'nothing inside braces');
}

// ── looks
{
  const ieee = L.resolve(tpl('ieee'));
  ok(ieee && ieee.engine === 'class', 'IEEE is a class look');
  const t = L.applyToTemplate(tpl('ieee'), ieee);
  ok(/\\documentclass\[journal\]\{IEEEtran\}/.test(t.preamble), 'class preamble kept');
  ok(/\\frenchspacing\\pretolerance=100 \\tolerance=800/.test(t.preamble), 'line-breaking settings added');
  ok(t.main_template === tpl('ieee').main_template, 'class skeleton untouched');
  // TeX's line count per column: floor((textheight - topskip)/baselineskip) + 1 = 58
  const G = L.geometry(ieee);
  eq(Math.floor(G.bodyH / G.leadPx + 1e-6), 58, 'IEEE column holds 58 lines');
  ok(/--pts-space:0\.35/.test(L.css(ieee, '.x')), 'IEEEtran retuned space reaches the typesetter');
  ok(L.resolve(tpl('ieee'), { layoutLook: 'submission' }) === null, 'submission mode = no look');
}
{
  const pn = L.resolve(tpl('pnas-new'));
  const t = L.applyToTemplate(tpl('pnas-new'), pn);
  ok(/\\abscontent/.test(t.main_template), 'PNAS sets its abstract (the class prints it only when asked)');
  ok(t.section_kind_to_command.introduction.type === 'bare', 'PNAS hides the Introduction heading');
}
{
  const nat = L.resolve(tpl('nature'));
  ok(nat.engine === 'spec', 'Nature is a spec look');
  const t = L.applyToTemplate(tpl('nature'), nat);
  ok(/\\documentclass\[twocolumn,10pt\]\{article\}/.test(t.preamble), 'spec look writes the page');
  ok(/\\setmainfont\{LibertinusSerif-Regular\}/.test(t.preamble), 'same font files as the browser');
  ok(t.author_block.format === 'look', 'the look sets the authors');
}
{
  // TeX spacing → CSS: two lines of the same style keep the TeX skip as the margin
  const look = L.resolve(tpl('nature'));
  const s = { family: 'text', size: 9.5, lead: 10.5 };
  ok(Math.abs(L.texGap(look, s, s, 6) - 6) < 1e-9, 'same style: margin = skip');
  const big = { family: 'sans', size: 20, lead: 24 };
  ok(Math.abs(L.texGap(look, big, s, 6) - 6) > 0.5, 'different styles: margin corrected for the line boxes');
}

console.log('paper-typeset: ' + n + ' checks · all passed');
