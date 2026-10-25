// V3.906 — the inline prose → LaTeX contract (paper-export-tex.js).
// node scripts/tests/paper-tex-escape.test.mjs
import fs from 'fs';
import vm from 'vm';
import assert from 'assert';
const root = new URL('../../', import.meta.url).pathname;
const ctx = { window: {}, console };
ctx.window.PaperLayout = (await import(root + 'rm/js/paper-layout-rules.js')).default;
vm.createContext(ctx);
// V3.915 — the pages load paper-prose-tex.js before the exporter
vm.runInContext(fs.readFileSync(root + 'rm/js/paper-prose-tex.js', 'utf8').replace('typeof window !== \'undefined\' ? window : globalThis', 'window'), ctx);
vm.runInContext(fs.readFileSync(root + 'rm/js/paper-export-tex.js', 'utf8'), ctx);
const T = ctx.window.PaperExportTex;
const tex = (s, tpl) => T.paragraphTextToTex(s, tpl);
let n = 0;
function eq(a, b, msg) { assert.strictEqual(a, b, msg); n++; }
// escaping — every special survives as text
eq(tex('50% of cells & 3 # of _x_'), '50\\% of cells \\& 3 \\# of \\_x\\_', 'specials');
eq(tex('a {b} c\\q'), 'a \\{b\\} c\\textbackslash{}q', 'braces / an unknown command stay text');
// V3.915 — LaTeX the author wrote in prose goes to LaTeX as written
eq(tex('[X] $\\pm$ [X]~\\si{\\micro\\metre} (n~=~[X]).'), '[X] $\\pm$ [X]~\\si{\\micro\\metre} (n~=~[X]).', 'ties + siunitx (MEBP)');
eq(tex('CV of [X]\\%, cost \\$[X]'), 'CV of [X]\\%, cost \\$[X]', 'escaped specials stay escaped once');
eq(tex('H~2~O and H\\textsubscript{2}O'), 'H\\textsubscript{2}O and H\\textsubscript{2}O', 'subscript both ways');
eq(tex('(\\cref{fig:system_overview})', { refs: { figure: { prefix: 'Fig.~' } } }), '(Fig.~\\ref{fig:system_overview})', 'cref without cleveref');
eq(tex('\\Cref{tab:bom} lists', {}), 'Table~\\ref{tab:bom} lists', 'Cref → template prefix');
eq(tex('\\cref{fig:a}', { _use_cref: true }), '\\cref{fig:a}', 'cleveref on → as written');
eq(tex('about ~5 um'), 'about \\textasciitilde{}5 um', 'tilde beside a space is a character');
eq(tex('a \\mebp{} b'), 'a \\textbackslash{}mebp\\{\\} b', 'unknown macro → text, never a compile error');
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
eq(T.bibEscape("J\\'{e}r\\^{o}me"), "J{\\'e}r{\\^o}me", 'BibTeX accents → accent commands, never a printed backslash');
eq(T.bibEscape('cost $5 ^ 2'), 'cost \\$5 \\textasciicircum{} 2', 'bib $ and ^');
// V3.910 — the layout check's Tighten / Loosen reaches the .tex as \looseness
eq(T.blockToTex({ kind: 'paragraph', body: 'Text.', attrs: { looseness: -1 } }, {}).indexOf('\\looseness=-1\\relax\n'), 0, 'tighten → \\looseness=-1');
eq(T.blockToTex({ kind: 'paragraph', body: 'Text.', attrs: {} }, {}).indexOf('looseness'), -1, 'no request → no \\looseness');
console.log('paper-tex-escape: ' + n + ' checks passed');
