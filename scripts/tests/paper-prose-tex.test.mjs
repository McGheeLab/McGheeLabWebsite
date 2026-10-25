// V3.915 — LaTeX written inside prose (rm/js/paper-prose-tex.js).
// node scripts/tests/paper-prose-tex.test.mjs
import { createRequire } from 'module';
import assert from 'assert';
const require = createRequire(import.meta.url);
const P = require('../../rm/js/paper-prose-tex.js');
let n = 0;
function eq(a, b, msg) { assert.deepStrictEqual(a, b, msg); n++; }

// reading commands
eq(P.readCommand('\\si{\\micro\\metre} x', 0).end, 17, 'si + one argument');
eq(P.readCommand('\\SI[mode=text]{5}{\\micro\\litre}', 0).args, ['5', '\\micro\\litre'], 'SI: option + two arguments');
eq(P.readCommand('\\textbf{a}[X]', 0).args, ['a'], 'no optional argument after a mandatory one');
eq(P.readCommand('\\%', 0).symbol, true, 'control symbol');
eq(P.readCommand('\\si{\\micro', 0), null, 'unbalanced argument → not a command');
eq(P.readCommand('\\pm 5', 0).resume, 4, 'a bare control word swallows the spaces after it');

// tildes: ties vs the builder's subscript
const t = (s) => P.tildeAt(s, s.indexOf('~')).kind;
eq(t('H~2~O'), 'sub', 'H~2~O');
eq(t('Ca~2+~'), 'sub', 'ion charge');
eq(t('OVA~257\u2013264~ peptide'), 'sub', 'en dash range (Nat Comm corpus)');
eq(t('t~1/2~'), 'sub', 'half-life');
eq(t('[X]~\\si{\\micro\\metre} (n~=~[X])'), 'tie', 'tie before a unit, not a subscript to the next ~');
eq(t('n~=~[X]'), 'tie', 'n~=~[X]');
eq(t('[X]~[X]~mm'), 'tie', 'bracketed placeholder is not a subscript');
eq(t('100~mm of travel'), 'tie', 'single tie');
eq(t('about ~5 um'), 'text', 'a tilde after a space is the character');

// siunitx
eq(P.unitHtml('\\micro\\metre'), '\u00B5m', 'µm');
eq(P.unitHtml('\\micro\\litre'), '\u00B5l', 'siunitx \\litre is l');
eq(P.unitHtml('\\milli\\metre\\per\\minute'), 'mm\u202Fmin<sup>\u22121</sup>', 'per → power −1');
eq(P.unitHtml('\\degreeCelsius'), '\u00B0C', '°C');
eq(P.unitHtml('mm/min'), 'mm/min', 'literal unit');
eq(P.unitHtml('\\micro m'), '\u00B5m', 'prefix on a literal unit');
eq(P.unitHtml('\\square\\centi\\metre'), 'cm<sup>2</sup>', 'square');
eq(P.numHtml('1.5e-3'), '1.5\u2009\u00D7\u200910<sup>\u22123</sup>', 'exponent');
eq(P.numHtml('12345'), '12\u202F345', 'digit groups');
eq(P.numHtml('2 +- 0.1'), '2 \u00B1 0.1', 'uncertainty');

const ctx = {
  render: (s) => s,
  ref: (kind, label, form) => (form === 'name' ? kind.slice(0, 3) + '. ' : '') + '#' + label,
  cite: (keys) => '[' + keys.join(',') + ']',
  footnote: (s) => '<fn>' + s + '</fn>',
  math: (s) => '<m>' + s + '</m>',
};
const h = (s) => P.toHtml(P.readCommand(s, 0), ctx);
eq(h('\\SI{37}{\\degreeCelsius}'), '<span class="pe-si">37\u202F\u00B0C</span>', 'SI');
eq(h('\\cref{fig:a,fig:b}'), 'fig. #fig:a and #fig:b', 'cref list');
eq(h('\\ref{tab:bom}'), '#tab:bom', 'bare ref');
eq(h('\\%'), '%', 'escaped percent');
eq(h('\\textsubscript{2}'), '<sub>2</sub>', 'textsubscript');
eq(h('\\unknownmacro{shown}'), null, 'unknown command → printed as source');

// export: refs follow the template, everything else stays LaTeX
const tctx = { ref: (k, l, f, cap) => (f === 'name' ? (cap ? 'Figure~' : 'Fig.~') : '') + '\\ref{' + l + '}', useCref: false };
const x = (s, c = tctx) => P.toTex(P.readCommand(s, 0), c);
eq(x('\\cref{fig:a}'), 'Fig.~\\ref{fig:a}', 'cref without cleveref');
eq(x('\\Cref{fig:a}'), 'Figure~\\ref{fig:a}', 'Cref capitalised');
eq(x('\\cref{fig:a}', { ...tctx, useCref: true }), null, 'cleveref loaded → verbatim');
eq(x('\\si{\\micro\\metre}'), null, 'siunitx verbatim');
eq(x('\\pm'), '\\ensuremath{\\pm}', 'math symbol in prose');
eq(x('\\micro'), '\\textmu{}', 'free-standing \\micro');
eq(x('\\mebp'), false, 'unknown macro → text');
eq(x('\\%'), null, 'escaped percent verbatim');
eq(P.packagesFor('5~\\si{\\micro\\metre} \\toprule \\begin{table}[H]'), ['siunitx', 'booktabs', 'float'], 'packages');
eq(P.preambleLoads('\\usepackage[detect-all]{siunitx}', 'siunitx'), true, 'already loaded');
eq(P.preambleLoads('\\usepackage{amsmath,booktabs}', 'booktabs'), true, 'loaded in a list');

// imported tables
const tab = P.parseTabular('\\begin{table}[H]\n\\centering\n\\caption{Bill of materials.}\n\\label{tab:bom}\n\\small\n' +
  '\\begin{tabular}{p{3cm}p{3.5cm}r}\n\\toprule\nComponent & Source & Cost (\\$) \\\\\n\\midrule\n' +
  'Board & FYSETC & [X] \\\\\nSyringes ($\\times$3) & Hamilton & [X] \\\\\n\\midrule\n\\textbf{Total} & & \\textbf{[X]} \\\\\n' +
  '\\bottomrule\n\\end{tabular}\n\\end{table}');
eq(tab.caption, 'Bill of materials.', 'caption');
eq(tab.label, 'tab:bom', 'label');
eq(tab.align, 'llr', 'alignment from p{} / r');
eq(tab.rows.length, 4, 'four rows');
eq(tab.rows[2][0].text, 'Syringes ($\\times$3)', 'cell keeps its LaTeX');
eq(tab.rulesAfter, [0, 2], 'midrules after the header and before the total');
eq(tab.header, true, 'header row');
// BibTeX accents in library metadata
eq(P.decodeAccents("Andr{\\'e} and J\\'{e}r\\^{o}me V\\\"or\\\"os"), 'Andr\u00E9 and J\u00E9r\u00F4me V\u00F6r\u00F6s', 'accents');
eq(P.decodeAccents('Stra{\\ss}e \\o{}ster'), 'Stra\u00DFe \u00F8ster', 'letter commands');
eq(P.decodeAccents('plain title'), 'plain title', 'no backslash → unchanged');
console.log('paper-prose-tex: ' + n + ' checks passed');
