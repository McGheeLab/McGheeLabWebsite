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
eq(tex('**S1 Field along *z* here.** Rest'), '\\textbf{S1 Field along \\emph{z} here.} Rest', 'italic inside bold (PLOS SI captions)');
eq(tex('**bold *it***'), '\\textbf{bold \\emph{it}}', 'italic closing a bold run');
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
// V3.918 — tables in two columns go through \rmTable (column or page by
// natural width, continued pieces); one-column output is unchanged
const ok = (c, msg) => { assert.ok(c, msg); n++; };
const has = (s, sub, msg) => ok(s.indexOf(sub) >= 0, msg + ' — missing ' + JSON.stringify(sub));
const TWO = { figure_environment: { compiled_columns: 2 } };
const ONE = { figure_environment: { compiled_columns: 1 } };
const bt = (attrs) => ({ kind: 'table', id: 't1', attrs: Object.assign({ rows: 3, cols: 2, header_row: true, booktabs: true, caption: 'Parts.',
  label: 'tab:p', anchor: 'flow', cells: { '0-0': 'Part', '0-1': 'Cost', '1-0': 'Board', '1-1': '43', '2-0': 'Rail', '2-1': '236' } }, attrs || {}) });
const one = T.blockToTex(bt(), ONE);
ok(one.indexOf('\\rmTable') < 0 && one.indexOf('\\begin{table}[') === 0, 'one column: a plain table float');
const two = T.blockToTex(bt(), TWO);
has(two, '\\def\\rmTspan{auto}', 'two columns: span decided by TeX');
has(two, '\\def\\rmTnat{>{\\rmTcellA}l<{\\rmTcellB}>{\\rmTcellA}l<{\\rmTcellB}}', 'natural spec: wrapping columns clipped to a third of the column');
has(T.blockToTex(bt({ style_json: JSON.stringify({ wrap: false }) }), TWO), '\\def\\rmTnat{ll}', 'a table that does not wrap: its own columns');
has(two, '\\def\\rmThead{Part & Cost \\\\ \\midrule}', 'header row repeats on every piece');
has(two, '\\rmTR{}{Board & 43 \\\\}\n  \\rmTR{}{Rail & 236 \\\\}', 'one \\rmTR per body row');
has(two, '\\def\\rmTcaption{\\caption{Parts.}\\label{tab:p}}', 'caption and label');
has(T.blockToTex(bt({ span: 'page' }), TWO), '\\def\\rmTspan{page}', 'page chosen');
has(T.blockToTex(bt({ span: 'one-column' }), TWO), '\\def\\rmTspan{column}', 'one column chosen');
has(T.blockToTex(bt({ span: 'column' }), TWO), '\\def\\rmTspan{auto}', 'the old default span:column means auto');
const LTX = '\\begin{center}\\scriptsize\\begin{longtable}{@{}p{0.2\\textwidth}l@{}}\\toprule\nA & B \\\\\n\\midrule\n\\endhead\nZ & 1 \\\\\n\\bottomrule\n\\end{longtable}\\end{center}';
const rawTwo = T.blockToTex({ kind: 'table', id: 't2', attrs: { raw_tex: LTX } }, TWO);
has(rawTwo, '\\def\\rmTsetup{\\scriptsize}', 'imported longtable → \\rmTable in two columns');
has(rawTwo, '\\rmTR{}{Z & 1 \\\\}', 'its body row');
eq(T.blockToTex({ kind: 'table', id: 't2', attrs: { raw_tex: LTX } }, ONE), LTX, 'one column: imported table verbatim');
const TX = '\\begin{table}\\begin{tabularx}{\\textwidth}{lX}a&b\\\\\\end{tabularx}\\end{table}';
eq(T.blockToTex({ kind: 'table', id: 't3', attrs: { raw_tex: TX } }, TWO), TX, 'what splitTable refuses stays verbatim');
eq(ctx.window.PaperLayout.tableSpan({ span: 'column' }), 'auto', 'tableSpan: legacy column → auto');
eq(ctx.window.PaperLayout.tableSpan({ span: 'one-column' }), 'column', 'tableSpan: one-column');
eq(ctx.window.PaperLayout.tableSpan({}), 'auto', 'tableSpan: none → auto');
// V3.919 — under a look an imported [H] float floats, so no page ends early
const LOOKT = { _look: { engine: 'spec' }, figure_environment: { compiled_columns: 1 } };
const FIGH = '\\begin{figure}[H]\n\\centering\\includegraphics{a}\n\\end{figure}';
eq(T.blockToTex({ kind: 'figure', id: 'f1', attrs: { raw_tex: FIGH } }, LOOKT), FIGH.replace('[H]', '[tbp]'), 'imported [H] figure → [tbp] under a look');
eq(T.blockToTex({ kind: 'figure', id: 'f1', attrs: { raw_tex: FIGH } }, ONE), FIGH, 'no look: as written');
eq(T.blockToTex({ kind: 'figure', id: 'f1', attrs: { raw_tex: FIGH.replace('figure}[H]', 'figure*}[h!]') } }, LOOKT).indexOf('\\begin{figure*}[tp]'), 0, 'starred → [tp]');
eq(T.blockToTex({ kind: 'table', id: 't9', attrs: { raw_tex: '\\begin{table}[t]x\\end{table}' } }, LOOKT), '\\begin{table}[t]x\\end{table}', '[t] stays [t]');
// V3.920 — panel references with or without the label's fig: prefix
eq(tex('see [!fig:fig:setup:A]'), 'see \\ref{fig:setup}\\,(A)', 'prefixed label + panel');
eq(tex('see [!fig:system:C]'), 'see \\ref{system}\\,(C)', 'unprefixed label + panel (bundle format)');
eq(tex('see [!fig:fig:setup]'), 'see \\ref{fig:setup}', 'prefixed label, no panel');
// V3.920 — math inside the paper's own \textbf{…}; an item opening with [
eq(tex('\\textbf{Plunger seat ($\\times$3).} Bolts'), '\\textbf{Plunger seat ($\\times$3).} Bolts', 'math inside \\textbf{} survives');
eq(tex('\\emph{a $x$ b}'), '\\emph{a $x$ b}', 'math inside \\emph{}');
ok(T.blockToTex({ kind: 'list', id: 'l1', body: '[DATA: counts]\nsecond', attrs: { list_type: 'bullet' } }, {}).indexOf('\\item {}[DATA: counts]') >= 0, 'an item opening with [ is not an optional label');
console.log('paper-tex-escape: ' + n + ' checks passed');
