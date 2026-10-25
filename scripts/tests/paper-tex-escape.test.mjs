// V3.906 — the inline prose → LaTeX contract (paper-export-tex.js).
// node scripts/tests/paper-tex-escape.test.mjs
import fs from 'fs';
import vm from 'vm';
import assert from 'assert';
const root = new URL('../../', import.meta.url).pathname;
const ctx = { window: {}, console };
ctx.window.PaperLayout = (await import(root + 'rm/js/paper-layout-rules.js')).default;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(root + 'rm/js/paper-export-tex.js', 'utf8'), ctx);
const T = ctx.window.PaperExportTex;
const tex = (s, tpl) => T.paragraphTextToTex(s, tpl);
let n = 0;
function eq(a, b, msg) { assert.strictEqual(a, b, msg); n++; }
// escaping — every special survives as text
eq(tex('50% of cells & 3 # of _x_'), '50\\% of cells \\& 3 \\# of \\_x\\_', 'specials');
eq(tex('a {b} c\\d'), 'a \\{b\\} c\\textbackslash{}d', 'braces/backslash');
// math is verbatim and never paired across spans
eq(tex('area $A_0^i$ while $P_0^i$ is'), 'area $A_0^i$ while $P_0^i$ is', 'two math spans');
eq(tex('cost \\$5 and $x$'), 'cost \\$5 and $x$', 'escaped dollar');
eq(tex('inline \\(a^2\\) ok'), 'inline \\(a^2\\) ok', '\\( \\)');
// markdown still works, with escaped content inside
eq(tex('**50% bold** and *it_al*'), '\\textbf{50\\% bold} and \\emph{it\\_al}', 'markdown + escapes');
eq(tex('CO~2~ and cm^-1^'), 'CO\\textsubscript{2} and cm\\textsuperscript{-1}', 'sub/sup');
eq(tex('a ~ lone tilde'), 'a \\textasciitilde{} lone tilde', 'lone tilde');
// Unicode → TeX that compiles with T1 and fontspec alike
eq(tex('200–300 nm — a “test” it’s'), "200--300 nm --- a ``test'' it's", 'dashes/quotes');
eq(tex('Ćirić Łukasz Müller'), "{\\'C}iri{\\'c} \\L{}ukasz M{\\\"u}ller", 'accent commands');
eq(tex('∼5 μm ± 2'), '\\ensuremath{\\sim}5 \\ensuremath{\\mu}m \\ensuremath{\\pm} 2', 'math symbols, Greek without Greek font');
eq(tex('5 μm', { _textGreek: true }), '5 μm', 'Greek with a Greek font');
eq(tex('Fig. 1'), 'Fig.~1', 'nbsp → tie');
// citations / refs unaffected
eq(tex('as shown [@smith2024; @doe2020].'), 'as shown \\cite{smith2024,doe2020}.', 'cite');
// bib
eq(T.bibEscape('Cell Biology & Toxicology 50%'), 'Cell Biology \\& Toxicology 50\\%', 'bib specials');
eq(T.bibEscape('Ćirić'), "{\\'C}iri{\\'c}", 'bib accents');
// V3.910 — the layout check's Tighten / Loosen reaches the .tex as \looseness
eq(T.blockToTex({ kind: 'paragraph', body: 'Text.', attrs: { looseness: -1 } }, {}).indexOf('\\looseness=-1\\relax\n'), 0, 'tighten → \\looseness=-1');
eq(T.blockToTex({ kind: 'paragraph', body: 'Text.', attrs: {} }, {}).indexOf('looseness'), -1, 'no request → no \\looseness');
console.log('paper-tex-escape: ' + n + ' checks passed');
