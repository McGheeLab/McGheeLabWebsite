// V3.921 — a journal look's page furniture and first-page sidebar (PLOS),
// shared by the .tex export and the Document view (rm/js/paper-look.js).
// node scripts/tests/paper-look-furniture.test.mjs
import fs from 'fs';
import assert from 'assert';
import { createRequire } from 'module';
const root = new URL('../../', import.meta.url).pathname;
const PL = createRequire(import.meta.url)(root + 'rm/js/paper-look.js');
const tpl = (id) => JSON.parse(fs.readFileSync(root + 'rm/data/paper-templates/' + id + '.json', 'utf8'));
const plos = PL.resolve(tpl('plos'), {});
const acs = PL.resolve(tpl('acs'), {});
let n = 0;
function eq(a, b, msg) { assert.strictEqual(a, b, msg); n++; }
function ok(v, msg) { assert.ok(v, msg); n++; }
function has(s, sub, msg) { ok(String(s).indexOf(sub) >= 0, msg + ' — missing: ' + sub); }

// names, titles, journal
eq(PL.citeName('Rafael D. González-Cruz'), 'González-Cruz RD', 'Surname + initials, periods dropped');
eq(PL.citeName('Jean-Pierre Martin'), 'Martin JP', 'hyphenated given name → two initials');
eq(PL.citeName('Prince'), 'Prince', 'one name');
eq(PL.shortTitle('A short title'), 'A short title', 'a short title is the running head');
eq(PL.shortTitle('The Microscope-Enabled 3D Bioprinter (ME3B): an open-source, condenser-turret module that adds needle-based bioprinting'),
  'The Microscope-Enabled 3D Bioprinter (ME3B)', 'the part before the colon');
ok(PL.shortTitle('One very long title without any colon in it that goes on and on and on past sixty').endsWith('…'), 'else cut at a word');
eq(PL.journalName(plos, 'PLOS Computational Biology'), 'PLOS Computational Biology', 'a PLOS target journal is named');
eq(PL.journalName(plos, 'PLoS ONE'), 'PLoS ONE', 'old spelling counts');
eq(PL.journalName(plos, 'Nature'), 'PLOS ONE', 'another journal → the look default');
eq(PL.journalName(plos, ''), 'PLOS ONE', 'no target → default');

// statements leave the body for the sidebar
const P = (body, id) => ({ kind: 'paragraph', id: id || 'p', body });
const secs = [
  { id: 's1', kind: 'introduction', label: 'Introduction', children: [P('Text.')] },
  { id: 's2', kind: 'custom', label: 'Funding', children: [P('NIH R01.\nSecond line.')] },
  { id: 's3', kind: 'custom', label: 'Declarations', children: [P('**CRediT.** roles', 'a'), P('**Declaration of competing interests.** None.', 'b'),
    P('**Data and source-file availability.** On Zenodo.', 'c')] },
  { id: 's4', kind: 'custom', special: 'data_availability', label: 'Whatever', children: [P('Also here.')] },
];
const sp = PL.sidebarSplit(plos, secs);
eq(sp.sections.map((s) => s.id).join(','), 's1,s3', 'a Funding section and a data_availability special leave the body');
eq(sp.sections[1].children.map((b) => b.id).join(','), 'a', 'run-in statements leave their section; others stay');
eq(secs[2].children.length, 3, 'the tree itself is not changed');
eq(sp.found.funding, 'NIH R01. Second line.', 'a source line break is a space');
eq(sp.found.competing, 'None.', 'run-in label stripped');
eq(sp.found.data, 'On Zenodo. Also here.', 'both data statements, in order');
eq(PL.sidebarSplit(acs, secs).sections, secs, 'a look without a sidebar leaves the tree alone');
eq(PL.sidebarSplit(plos, [{ id: 'x', label: 'Funding sources and acknowledgements of the many people', children: [] }]).sections.length, 1,
  'a longer heading is not a statement');

// the sidebar's paragraphs
const seven = ['Alex McGhee', 'Jane Doe', 'Rui Chen', 'María José García-López', 'Wei Zhang', 'Priya N. Raman', 'Tomás Ó Briain'].map((name) => ({ name }));
const items = PL.sidebarItems(plos, { authors: seven, title: 'A title.', journal: 'PLOS ONE', year: 2026, found: { funding: 'NIH.' } });
eq(items[0], '**Citation:** McGhee A, Doe J, Chen R, García-López MJ, Zhang W, Raman PN, et al. (2026) A title. PLOS ONE.', 'six names then et al.');
has(items[1], '**Copyright:** © 2026 McGhee et al. This is an open access article', 'three or more → et al.');
eq(PL.sidebarItems(plos, { authors: seven.slice(0, 2), title: 'T', journal: 'J', year: 2026, found: {} })[1].slice(0, 36), '**Copyright:** © 2026 McGhee, Doe. T', 'two authors named');
eq(items.slice(2).join(' | '), '**Data Availability Statement:** add the data availability statement before submission. | **Funding:** NIH. | ' +
  '**Competing interests:** add the competing-interests statement before submission.', 'missing statements say so');

// TeX: the box, the split, the furniture
const box = PL.texSidebar(plos, ['A', 'B']);
ok(box.indexOf('\\z@') < 0, 'no internal-only lengths in the document body');
has(box, '\\prevdepth=0pt', 'first baseline one \\baselineskip below the top');
has(box, '\\spaceskip=\\fontdimen2\\font', 'no interword shrink');
has(box, '\\exhyphenpenalty=0', 'breaks at a hyphen like the browser');
has(box, '\\vsplit\\rmSideBox to 366.4bp', 'split at page 1\'s span (709 − 353.6) + one line');
has(box, '{\\sffamily OPEN ACCESS\\par}\n  \\vskip-0.6bp', 'the head, 16.4 bp above the first item');
const furn = PL.texFurniture(plos, { journal: 'PLOS ONE', shortTitle: 'Short' }, (s) => s);
has(furn, '\\put(35,-48.3){\\sffamily\\bfseries\\fontsize{20.6bp}', 'masthead on page 1');
has(furn, '\\put(576,-46.2){\\llap{', 'running title right-aligned on later pages');
has(furn, '\\thepage{} / \\pageref*{LastPage}', 'folio keeps its space');
has(furn, '\\put(36,-709){\\box\\rmSideA}', 'page 1 part, last baseline at 709');
has(furn, '\\put(36,-72.3){\\vtop{\\kern\\z@\\unvbox\\rmSideBox}}', 'page 2 part, first baseline at 83.3');
const pre = PL.texPreamble(plos);
has(pre, '\\newfontfamily\\rmSideFont{texgyreheroscn-regular}', 'sidebar face');
has(pre, '\\usepackage{lastpage}', 'n / N needs the last page');
has(pre, '\\AddToHook{shipout/background}{\\rmPageFurniture}', 'drawn by the shipout hook');
has(pre, '\\pagestyle{empty}', 'no second folio');
ok(PL.texPreamble(acs).indexOf('rmPageFurniture') < 0, 'a look without furniture has no hook');
const main = PL.texMain(plos, tpl('plos'));
ok(main.indexOf('{{RM_PAGE_FURNITURE}}') < main.indexOf('\\begin{document}') && main.indexOf('{{RM_SIDEBAR}}') > main.indexOf('\\begin{document}'), 'tokens around \\begin{document}');
ok(PL.texMain(acs, tpl('acs')).indexOf('{{RM_') < 0, 'no tokens without furniture');
const front = PL.texFront(plos);
has(front, '\\vspace*{\\dimexpr36bp-\\topskip\\relax}\\nointerlineskip', 'page 1 front starts 36 bp lower, exactly');
has(front, '\\begingroup\\parskip=0pt\\relax', 'front is rigid');
has(front, '\\lineskiplimit=-\\maxdimen', 'front lines \\baselineskip apart');
has(front, '\\endgroup\n}', 'group closed');
ok(PL.texFront(acs).indexOf('\\vspace*') < 0, 'no offset where the look has none');
has(front, '\\parindent=0bp\\relax {{ABSTRACT}}', 'abstract paragraphs start flush under a heading label');
const acsFront = PL.texFront(acs);
ok(acsFront.indexOf('\\lineskiplimit') < acsFront.indexOf('{{AFFILIATIONS}}') && acsFront.lastIndexOf('\\lineskiplimit') < acsFront.indexOf('{{ABSTRACT}}') &&
  acsFront.slice(acsFront.indexOf('\\colorbox')).indexOf('\\lineskiplimit') < 0, 'a boxed abstract keeps \\lineskip (JACS box over the affiliations)');

// CSS
const css = PL.css(plos, '.pdv-look-on');
has(css, '.pdv-look-on .pdv-sidebar{position:absolute;', 'sidebar CSS');
has(css, '"PL Heros Cn"', 'in its face');
has(css, '.pdv-sheet.pdv-has-folio .pdv-pageno{display:none;}', 'the grey page counter steps aside for the folio');
has(PL.fontFaceCss(), 'texgyreheroscn-regular.otf', 'the face is served');
ok(fs.existsSync(root + 'rm/vendor/fonts/texgyreheroscn-bold.otf'), 'the bold face is vendored');
console.log('paper-look-furniture: ' + n + ' checks passed');
