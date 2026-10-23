/* Learning Modules placements (V3.716).
 *
 *   node scripts/tests/module-placements.test.mjs
 *
 * Pure logic, no emulator, no browser — layer 1.
 *
 * WHAT THIS GUARDS. Every "Learning Modules" section in a class used to render
 * the SAME list, because renderSectionBody's `case 'modules'` called
 * renderModulesBody(editing) without passing `section`, and renderModulesBody
 * read the one class-wide `_classData.modules`. A second modules section was a
 * copy of the first, and adding a module anywhere changed all of them. The bug
 * was a missing argument — invisible in review, obvious to a person using it —
 * so it is worth a test that would have caught it.
 *
 * The array is still flat and class-wide; it is PARTITIONED by `sectionId`.
 * Three invariants matter and are each asserted below:
 *
 *   1. A section renders its own modules and nothing else.
 *   2. Nothing is ever silently lost — an entry with no `sectionId` (everything
 *      authored before V3.716) or one pointing at a deleted section is adopted
 *      by the FIRST modules section.
 *   3. Teacher-classes (created with `tabs: []`, rendered straight off
 *      `schedule.modules` by teacher-classes.js) are untouched: no sectionId is
 *      stamped and navigation stays class-wide.
 *
 * It also covers the routing half: the module route now carries a placement id
 * instead of a bare filename, because `modules/manifest.json` holds seven files
 * named `overview.html` and the old `findIndex(m => m.htmlFile === ...)`
 * resolved by first match — opening one section's overview with the OTHER
 * section's folder.
 *
 * Method: the functions under test are EXTRACTED FROM class-builder.js at run
 * time and executed, rather than reimplemented here. If the source changes,
 * this test runs the changed source; it cannot drift into testing a copy.
 */
import { readFileSync } from 'node:fs';

const SRC_PATH = new URL('../../class-builder.js', import.meta.url).pathname;
const src = readFileSync(SRC_PATH, 'utf8');

/* ── harness ─────────────────────────────────────────────────────────────── */

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; return; }
  failures.push(detail ? `${name} — ${detail}` : name);
  console.log(` FAIL ${detail ? `${name} — ${detail}` : name}`);
}
const eq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want),
        JSON.stringify(got) === JSON.stringify(want)
          ? '' : `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

/** Pull one top-level `function name(...) { ... }` out of the source. */
function grabFn(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`class-builder.js no longer defines ${name}()`);
  let depth = 0;
  for (let j = src.indexOf('{', start); j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(start, j + 1); }
  }
  throw new Error(`unbalanced braces in ${name}()`);
}

/** V3.803 — pull one top-level `const NAME = {…};` / `[…];` out of the source. */
function grabConst(name) {
  const start = src.indexOf(`const ${name} =`);
  if (start < 0) throw new Error(`class-builder.js no longer defines ${name}`);
  const open = start + src.slice(start).search(/[[{]/);
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    const c = src[j];
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') { depth--; if (depth === 0) return src.slice(start, j + 1) + ';'; }
  }
  throw new Error(`unbalanced brackets in ${name}`);
}

/** Pull the source BETWEEN two anchors (for logic that isn't its own function). */
function grabBetween(afterMarker, beforeMarker, label) {
  const a = src.indexOf(afterMarker);
  const b = src.indexOf(beforeMarker, a + 1);
  if (a < 0 || b < 0) throw new Error(`could not locate ${label} in class-builder.js`);
  return src.slice(a, b);
}

/* esc() builds a throwaway DOM node, so give it just enough document. */
const documentShim = {
  createElement: () => ({
    set textContent(v) { this._v = String(v ?? ''); },
    get innerHTML() {
      return this._v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
  })
};

/* ── subject 1: the placement helpers + the section body renderer ────────── */

const builder = new Function('document', `
  let _tabs = [], _classData = {}, _scheduleId = 'bme466';
  /* Not under test: homework labels come from file sections, which are
     unrelated to placements. */
  function getHomeworkLabel() { return null; }
  /* V3.803 — the type helpers + the typed-list section read the registry. */
  ${['SECTION_REG', 'MODULE_TYPES', 'MODULE_TYPE_HOME', 'MODULE_TYPE_HIDDEN_DEFAULT', 'MODULE_TYPE_SHORT']
     .map(grabConst).join('\n')}
  ${['esc', 'escAttr', 'genBlockId', 'genTabId', 'findSectionById', 'isNotesEntry',
     'guessModuleType', 'moduleType', 'moduleTypeLabel', 'moduleHomeKey', 'defaultPublishedFor', 'ensureModuleTypes',
     'modulesSections', 'ensureModulePlacements', 'modulesForSection',
     'modulesForTypedSection', 'findHomeworkTab', 'typedListLocation', 'ensureTypedModuleTabs',
     'moduleNumBadge', 'moduleTypeTag', 'renderTypedModulesBody', 'moduleProgressLabel',
     'renderModulesBody'].map(grabFn).join('\n\n')}
  return {
    load: (tabs, data) => { _tabs = tabs; _classData = data; },
    modulesSections, ensureModulePlacements, modulesForSection, renderModulesBody,
    moduleType, moduleHomeKey, defaultPublishedFor, modulesForTypedSection,
    ensureTypedModuleTabs, renderTypedModulesBody, moduleProgressLabel,
    guessModuleType, ensureModuleTypes
  };
`)(documentShim);

/* ── subject 2: the viewer's resolve + prev/next block ───────────────────── */

const resolveBlock = grabBetween(
  '    /* V3.716 — placement id first, filename second.',
  '    // Set iframe src using the folder from the module data',
  "wireModuleViewer's placement resolve"
);

const openModule = new Function('schedule', 'modRef', 'classId', `
  ${['MODULE_TYPES', 'MODULE_TYPE_HOME'].map(grabConst).join('\n')}
  ${['isNotesEntry', 'guessModuleType', 'moduleType', 'moduleHomeKey'].map(grabFn).join('\n')}
  const modules = (schedule.modules || [])
    .filter(m => m.published)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
${resolveBlock}
  const folder = current?.folder || classId;
  return {
    id: current?.id ?? null,
    folder,
    src: 'modules/' + encodeURIComponent(folder) + '/' + encodeURIComponent(moduleFile)
         + '?class=' + encodeURIComponent(classId)
         + (current?.id ? '&mod=' + encodeURIComponent(current.id) : ''),
    prev: prev?.id ?? null,
    next: next?.id ?? null,
    progress: currentIdx >= 0 ? \`\${currentIdx + 1} of \${siblings.length}\` : null
  };
`);

/* ════════════════════════════════════════════════════════════════════════════
   1. MIGRATION — a class authored before V3.716
   ════════════════════════════════════════════════════════════════════════ */
{
  const tabs = [{ id: 't1', sections: [
    { id: 'blk_ov',  key: 'overview' },
    { id: 'blk_mod', key: 'modules', name: 'Learning Modules' }
  ]}];
  const data = { modules: [
    { id: 'mod_1', htmlFile: 'a.html', order: 0 },
    { id: 'mod_2', htmlFile: 'b.html', order: 1 }
  ]};
  builder.load(tabs, data);
  builder.ensureModulePlacements();

  eq('legacy entries adopted by the only modules section',
     data.modules.map(m => m.sectionId), ['blk_mod', 'blk_mod']);
  eq('adoption preserves order',
     builder.modulesForSection('blk_mod').map(m => m.id), ['mod_1', 'mod_2']);
}

/* A modules section added LATER must not swallow the existing list. */
{
  const tabs = [
    { id: 't1', sections: [{ id: 'blk_A', key: 'modules' }] },
    { id: 't2', sections: [{ id: 'blk_NEW', key: 'modules' }] }
  ];
  const data = { modules: [{ id: 'mod_1', htmlFile: 'a.html', order: 0 }] };
  builder.load(tabs, data);
  builder.ensureModulePlacements();
  eq('legacy entry homes to the FIRST modules section', data.modules[0].sectionId, 'blk_A');
  eq('a newly added section starts empty', builder.modulesForSection('blk_NEW'), []);
}

/* Only sections of key 'modules' are placement homes. */
{
  const data = { modules: [{ id: 'mod_1', htmlFile: 'a.html', order: 0 }] };
  const before = JSON.stringify(data);
  builder.load([{ id: 't1', sections: [
    { id: 'blk_wb', key: 'whiteboard' }, { id: 'blk_f', key: 'files' }
  ]}], data);
  builder.ensureModulePlacements();
  eq('whiteboard/files sections are not placement homes', JSON.stringify(data), before);
}

/* ════════════════════════════════════════════════════════════════════════════
   2. NO SILENT LOSS — a deleted section's lessons are re-homed
   ════════════════════════════════════════════════════════════════════════ */
{
  const data = { modules: [
    { id: 'mod_1', htmlFile: 'a.html', order: 0, sectionId: 'blk_GONE' },
    { id: 'mod_2', htmlFile: 'b.html', order: 0, sectionId: 'blk_B' }
  ]};
  builder.load([{ id: 't1', sections: [{ id: 'blk_B', key: 'modules' }] }], data);
  builder.ensureModulePlacements();
  eq('orphan of a deleted section is adopted, nothing lost',
     builder.modulesForSection('blk_B').map(m => m.id).sort(), ['mod_1', 'mod_2']);
}

/* ════════════════════════════════════════════════════════════════════════════
   3. TEACHER-CLASSES — tabs:[] must be left exactly alone
   ════════════════════════════════════════════════════════════════════════ */
{
  const data = { modules: [
    { id: 'optics--03-lenses',  htmlFile: '03-lenses.html',  order: 0 },
    { id: 'optics--04-mirrors', htmlFile: '04-mirrors.html', order: 1 }
  ]};
  const before = JSON.stringify(data);
  builder.load([], data);
  builder.ensureModulePlacements();
  eq('no modules section → array untouched', JSON.stringify(data), before);
  check('no sectionId stamped on a teacher-class',
        data.modules.every(m => !('sectionId' in m)));
}

/* Defensive: a class with no modules array at all must not throw. */
{
  builder.load([{ id: 't1', sections: [{ id: 'blk_A', key: 'modules' }] }], {});
  builder.ensureModulePlacements();
  eq('missing modules array is safe', builder.modulesForSection('blk_A'), []);
}

/* ════════════════════════════════════════════════════════════════════════════
   4. THE BUG ITSELF — two sections must render different HTML
   ════════════════════════════════════════════════════════════════════════ */
{
  const tabs = [
    { id: 't1', sections: [{ id: 'blk_A', key: 'modules', name: 'Week 1' }] },
    { id: 't2', sections: [{ id: 'blk_B', key: 'modules', name: 'Week 2' }] },
    { id: 't3', sections: [{ id: 'blk_C', key: 'modules', name: 'Week 3' }] }
  ];
  const data = { modules: [
    { id: 'mod_a1', sectionId: 'blk_A', htmlFile: 'a1.html', folder: 'f', order: 0, published: true,  title: 'A one' },
    { id: 'mod_a2', sectionId: 'blk_A', htmlFile: 'a2.html', folder: 'f', order: 1, published: false, title: 'A two hidden' },
    { id: 'mod_a3', sectionId: 'blk_A', htmlFile: 'a3.html', folder: 'f', order: 2, published: true,  title: 'A notes', kind: 'notes' },
    { id: 'mod_b1', sectionId: 'blk_B', htmlFile: 'b1.html', folder: 'g', order: 0, published: true,  title: 'B one' }
  ]};
  builder.load(tabs, data);
  builder.ensureModulePlacements();

  const [A, B, C] = [tabs[0].sections[0], tabs[1].sections[0], tabs[2].sections[0]];
  const cards = h => (h.match(/<div class="cb-mod-card(?:"| )/g) || []).length;
  const links = h => (h.match(/class="cb-module-link"/g) || []).length;

  // Admin / editing view
  const eA = builder.renderModulesBody(true, A);
  const eB = builder.renderModulesBody(true, B);
  const eC = builder.renderModulesBody(true, C);

  eq('edit: section A shows its 3 modules', cards(eA), 3);
  eq('edit: section B shows its 1 module',  cards(eB), 1);
  check('edit: A does not leak B\'s module', !eA.includes('mod_b1'));
  check('edit: B does not leak A\'s modules', !eB.includes('mod_a1') && !eB.includes('mod_a3'));
  check('edit: an empty section says so instead of copying',
        eC.includes('No modules configured yet') && !eC.includes('mod_a1'));

  check('edit: + Add Module carries its own section id',
        eA.includes('cb-mod-add" data-section-id="blk_A"'));
  check('edit: + Add Notes carries its own section id',
        eA.includes('cb-mod-add-notes" data-section-id="blk_A"'));
  check('edit: an empty section\'s add button still carries its id',
        eC.includes('data-section-id="blk_C"'));
  check('edit: section B\'s buttons never claim section A',
        !eB.includes('data-section-id="blk_A"'));

  check('edit: reorder arrows disable at the SECTION\'s ends',
        /data-dir="up" data-mod-id="mod_a1" disabled/.test(eA) &&
        /data-dir="down" data-mod-id="mod_a3" disabled/.test(eA));
  check('edit: a lone module in a section is disabled both ways',
        /data-dir="up" data-mod-id="mod_b1" disabled/.test(eB) &&
        /data-dir="down" data-mod-id="mod_b1" disabled/.test(eB));

  // Public / student view
  const pA = builder.renderModulesBody(false, A);
  const pB = builder.renderModulesBody(false, B);
  const pC = builder.renderModulesBody(false, C);

  eq('public: A shows 2 links (unpublished hidden)', links(pA), 2);
  eq('public: B shows 1 link', links(pB), 1);
  check('public: unpublished module stays hidden', !pA.includes('mod_a2'));
  check('public: an empty section reads as empty', pC.includes('No modules available yet'));

  check('public: href is the placement id, not the filename',
        pA.includes('#/classes/bme466/modules/mod_a1') && !pA.includes('modules/a1.html'));
  check('public: B links to B\'s placement', pB.includes('#/classes/bme466/modules/mod_b1'));

  check('public: each section numbers its lessons from 1',
        pA.includes('>1</span>') && pB.includes('>1</span>'));
  eq('public: notes do not consume a lesson number',
     (pA.match(/>1<\/span>/g) || []).length, 1);
  check('public: notes render the pencil badge', pA.includes('✎'));

  check('REGRESSION GUARD: two modules sections render different HTML',
        eA !== eB && pA !== pB);
}

/* ════════════════════════════════════════════════════════════════════════════
   5. ROUTING — a placement id opens ITS placement, with ITS folder
   ════════════════════════════════════════════════════════════════════════ */
{
  /* The case that was broken: the same filename, two folders, two sections.
     manifest.json really does hold seven files named overview.html. */
  const schedule = {
    tabs: [
      { id: 't1', sections: [{ id: 'blk_A', key: 'modules' }] },
      { id: 't2', sections: [{ id: 'blk_B', key: 'modules' }] }
    ],
    modules: [
      { id: 'mod_a1', sectionId: 'blk_A', htmlFile: 'overview.html',  folder: 'foundations', order: 0, published: true, title: 'Foundations overview' },
      { id: 'mod_a2', sectionId: 'blk_A', htmlFile: '01-intro.html',  folder: 'foundations', order: 1, published: true, title: 'Intro' },
      { id: 'mod_b1', sectionId: 'blk_B', htmlFile: 'overview.html',  folder: 'equipment',   order: 0, published: true, title: 'Equipment overview' },
      { id: 'mod_b2', sectionId: 'blk_B', htmlFile: '02-balance.html', folder: 'equipment',  order: 1, published: true, title: 'Balance' }
    ]
  };

  let r = openModule(schedule, 'mod_a1', 'bme466');
  eq('route: A/overview resolves to A\'s placement', r.id, 'mod_a1');
  eq('route: A/overview loads the foundations copy', r.folder, 'foundations');
  eq('route: A/overview iframe src',
     r.src, 'modules/foundations/overview.html?class=bme466&mod=mod_a1');
  eq('route: A/overview prev/next stay inside section A', [r.prev, r.next], [null, 'mod_a2']);
  eq('route: progress counts section A only', r.progress, '1 of 2');

  r = openModule(schedule, 'mod_b1', 'bme466');
  eq('route: B/overview resolves to B\'s placement', r.id, 'mod_b1');
  eq('route: B/overview loads the EQUIPMENT copy (this was the bug)', r.folder, 'equipment');
  eq('route: B/overview iframe src',
     r.src, 'modules/equipment/overview.html?class=bme466&mod=mod_b1');
  eq('route: B/overview prev/next stay inside section B', [r.prev, r.next], [null, 'mod_b2']);

  r = openModule(schedule, 'mod_a2', 'bme466');
  eq('route: last lesson of A has no next (no bleed into B)',
     [r.prev, r.next], ['mod_a1', null]);

  /* Pre-V3.716 bookmarks pass a bare filename and must still open. */
  r = openModule(schedule, 'overview.html', 'bme466');
  eq('route: filename fallback still opens a module', r.id, 'mod_a1');
  eq('route: filename fallback yields a loadable src',
     r.src, 'modules/foundations/overview.html?class=bme466&mod=mod_a1');
}

/* A class whose doc has not been re-saved since V3.716 has no sectionId
   anywhere; the viewer applies the same adoption rule rather than falling back
   to class-wide navigation. */
{
  const schedule = {
    tabs: [{ id: 't1', sections: [{ id: 'blk_only', key: 'modules' }] }],
    modules: [
      { id: 'mod_1', htmlFile: 'a.html', folder: 'f', order: 0, published: true, title: 'A' },
      { id: 'mod_2', htmlFile: 'b.html', folder: 'f', order: 1, published: true, title: 'B' }
    ]
  };
  const r = openModule(schedule, 'mod_1', 'c1');
  eq('route: un-resaved class still navigates by section', [r.prev, r.next], [null, 'mod_2']);
  eq('route: un-resaved class progress', r.progress, '1 of 2');
}

/* Teacher-class: no tabs, catalog ids, class-wide navigation — unchanged. */
{
  const schedule = {
    tabs: [],
    modules: [
      { id: 'optics--03-lenses',  htmlFile: '03-lenses.html',  folder: 'optics', order: 0, published: true, title: 'Lenses' },
      { id: 'optics--04-mirrors', htmlFile: '04-mirrors.html', folder: 'optics', order: 1, published: true, title: 'Mirrors' }
    ]
  };
  let r = openModule(schedule, '03-lenses.html', 'tc1');
  eq('route: teacher-class filename link resolves', r.id, 'optics--03-lenses');
  eq('route: teacher-class navigation stays class-wide', [r.prev, r.next], [null, 'optics--04-mirrors']);
  eq('route: teacher-class progress spans the whole list', r.progress, '1 of 2');
  r = openModule(schedule, 'optics--04-mirrors', 'tc1');
  eq('route: teacher-class catalog id also resolves', r.id, 'optics--04-mirrors');
}

/* A teacher granted TWO folders gets two entries named overview.html
   (buildModules in rm/js/admin-teachers.js walks every granted folder). The old
   filename link made the second one unreachable and opened the first's folder;
   the catalog id disambiguates them. */
{
  const schedule = {
    tabs: [],
    modules: [
      { id: 'optics--overview',    htmlFile: 'overview.html', folder: 'optics',    order: 0, published: true, title: 'Optics overview' },
      { id: 'equipment--overview', htmlFile: 'overview.html', folder: 'equipment', order: 1, published: true, title: 'Equipment overview' }
    ]
  };
  let r = openModule(schedule, 'optics--overview', 'tc1');
  eq('route: teacher-class optics/overview loads the optics folder', r.folder, 'optics');
  r = openModule(schedule, 'equipment--overview', 'tc1');
  eq('route: teacher-class equipment/overview loads the EQUIPMENT folder', r.folder, 'equipment');
  eq('route: teacher-class equipment/overview resolves its own id', r.id, 'equipment--overview');
}

/* An unpublished file opened directly (instructors test before release): no
   placement resolves, but the file must still load and nothing may throw. */
{
  const schedule = { tabs: [], modules: [
    { id: 'mod_x', htmlFile: 'draft.html', folder: 'f', published: false, title: 'Draft' }
  ]};
  const r = openModule(schedule, 'draft.html', 'c1');
  eq('route: unpublished resolves no placement', r.id, null);
  eq('route: unpublished still builds a src', r.src, 'modules/c1/draft.html?class=c1');
  eq('route: unpublished shows no progress', r.progress, null);
}

/* ════════════════════════════════════════════════════════════════════════════
   7. TYPES (V3.803) — homework/keys and reports/tests leave the stack for
      their own tab; the tab is made on demand; prev/next follow the list
   ════════════════════════════════════════════════════════════════════════ */

/* 7a. the vocabulary and the defaults */
{
  eq('type: absent type is a module', builder.moduleType({}), 'module');
  eq('type: unknown type is a module', builder.moduleType({ type: 'quiz' }), 'module');
  eq('type: notes never have a listing home', builder.moduleHomeKey({ kind: 'notes', type: 'homework' }), null);
  eq('type: homework + key list on Homework & Keys',
     [builder.moduleHomeKey({ type: 'homework' }), builder.moduleHomeKey({ type: 'homework_key' })],
     ['homeworkModules', 'homeworkModules']);
  eq('type: report + test list on Reports & Tests',
     [builder.moduleHomeKey({ type: 'report' }), builder.moduleHomeKey({ type: 'test' })],
     ['reportTestModules', 'reportTestModules']);
  eq('type: module + pretest stay in the stack',
     [builder.moduleHomeKey({ type: 'module' }), builder.moduleHomeKey({ type: 'pretest' }), builder.moduleHomeKey({})],
     [null, null, null]);
  eq('default visibility: keys and tests start hidden',
     [builder.defaultPublishedFor('module', 'homework_key'), builder.defaultPublishedFor('module', 'test')], [false, false]);
  eq('default visibility: module / pretest / homework / report start visible',
     ['module', 'pretest', 'homework', 'report'].map(t => builder.defaultPublishedFor('module', t)), [true, true, true, true]);
  eq('default visibility: notes stay hidden whatever the type', builder.defaultPublishedFor('notes', 'module'), false);
}

/* 7b. BME 466's shape: Homework & Keys joins the EXISTING Homeworks tab (under
   the Assignments & Due Dates table); Reports & Tests gets its own public tab
   right after it, before the gated tabs. */
{
  const tabs = [
    { id: 't_mod',  name: 'Learning Modules', sections: [{ id: 'blk_mod', key: 'modules', name: 'Learning Modules' }] },
    { id: 't_wb',   name: 'Whiteboard',       sections: [{ id: 'blk_wb', key: 'whiteboard' }] },
    { id: 't_hw',   name: 'Homeworks',        sections: [{ id: 'blk_hwlist', key: 'hwList466' }] },
    { id: 't_mine', name: 'My Homework', studentOnly: true, sections: [{ id: 'blk_mine', key: 'hwMine466' }] },
    { id: 't_dash', name: 'Dashboard',   adminOnly: true,   sections: [{ id: 'blk_dash', key: 'hwDash466' }] }
  ];
  const data = { modules: [
    { id: 'mod_pre',  sectionId: 'blk_mod', htmlFile: 'hw-00-pretest.html',   folder: 'bme466', order: -1, published: true,  title: 'Pretest',    type: 'pretest' },
    { id: 'mod_w1',   sectionId: 'blk_mod', htmlFile: '01.html',              folder: 'bme466', order: 0,  published: true,  title: 'Week 1' },
    { id: 'mod_hw1',  sectionId: 'blk_mod', htmlFile: 'hw-01.html',           folder: 'bme466', order: 1,  published: true,  title: 'Homework 1', type: 'homework' },
    { id: 'mod_key1', sectionId: 'blk_mod', htmlFile: 'HW1-student-key.html', folder: 'bme466', order: 2,  published: false, title: 'HW1 key',    type: 'homework_key' },
    { id: 'mod_w2',   sectionId: 'blk_mod', htmlFile: '02.html',              folder: 'bme466', order: 3,  published: true,  title: 'Week 2' },
    { id: 'mod_r1',   sectionId: 'blk_mod', htmlFile: 'report-01.html',       folder: 'bme466', order: 4,  published: true,  title: 'Report 1',   type: 'report' },
    { id: 'mod_t1',   sectionId: 'blk_mod', htmlFile: 'test-01.html',         folder: 'bme466', order: 5,  published: false, title: 'Midterm',    type: 'test' }
  ]};
  builder.load(tabs, data);
  builder.ensureModulePlacements();
  const created = builder.ensureTypedModuleTabs();

  eq('ensure: reports what it made', created,
     ['Homework & Keys section on the Homeworks tab', 'Reports & Tests tab']);
  eq('ensure: Homework & Keys joined the existing Homeworks tab, below the due-date table',
     tabs[2].sections.map(s => s.key), ['hwList466', 'homeworkModules']);
  eq('ensure: Reports & Tests is a new public tab after Homeworks, before the gated tabs',
     tabs.map(t => t.name), ['Learning Modules', 'Whiteboard', 'Homeworks', 'Reports & Tests', 'My Homework', 'Dashboard']);
  check('ensure: the new tab carries no gate flag', !tabs[3].adminOnly && !tabs[3].staffOnly && !tabs[3].studentOnly);
  eq('ensure: idempotent — a second pass makes nothing', builder.ensureTypedModuleTabs(), []);
  eq('ensure: idempotent — tab count unchanged', tabs.length, 6);

  eq('typed list: Homework & Keys holds homework + key in stack order',
     builder.modulesForTypedSection('homeworkModules').map(m => m.id), ['mod_hw1', 'mod_key1']);
  eq('typed list: Reports & Tests holds report + test',
     builder.modulesForTypedSection('reportTestModules').map(m => m.id), ['mod_r1', 'mod_t1']);

  const links = h => (h.match(/class="cb-module-link"/g) || []).length;
  const pStack = builder.renderModulesBody(false, tabs[0].sections[0]);
  eq('public stack: only the pretest and the two weeks remain', links(pStack), 3);
  check('public stack: homework / key / report / test are not in the stack',
        !pStack.includes('mod_hw1') && !pStack.includes('mod_key1') && !pStack.includes('mod_r1') && !pStack.includes('mod_t1'));
  check('public stack: the pretest is badged and takes no lesson number',
        pStack.includes('PRETEST') && pStack.includes('>1</span>') && pStack.includes('>2</span>') && !pStack.includes('>3</span>'));

  const hwSec = tabs[2].sections[1];
  const pHw = builder.renderTypedModulesBody(false, hwSec);
  eq('public Homeworks list: the visible homework only (the key is still hidden)', links(pHw), 1);
  check('public Homeworks list: links by placement id', pHw.includes('#/classes/bme466/modules/mod_hw1'));
  check('public Homeworks list: the hidden key is not leaked', !pHw.includes('mod_key1') && !pHw.includes('HW1-student-key'));
  data.modules.find(m => m.id === 'mod_key1').published = true;
  const pHw2 = builder.renderTypedModulesBody(false, hwSec);
  eq('public Homeworks list: ticking Visible releases the key', links(pHw2), 2);
  check('public Homeworks list: the key is badged HOMEWORK KEY', pHw2.includes('HOMEWORK KEY'));

  const pRt = builder.renderTypedModulesBody(false, tabs[3].sections[0]);
  eq('public Reports & Tests: report visible, test hidden', links(pRt), 1);
  check('public Reports & Tests: badged REPORT', pRt.includes('>REPORT</span>'));

  const cards = h => (h.match(/<div class="cb-mod-card(?:"| )/g) || []).length;
  const eStack = builder.renderModulesBody(true, tabs[0].sections[0]);
  eq('editor stack: still manages ALL seven entries', cards(eStack), 7);
  eq('editor stack: every card has a type select', (eStack.match(/class="cb-mod-type"/g) || []).length, 7);
  const keySel = (eStack.match(/<select class="cb-mod-type" data-mod-id="mod_key1">([\s\S]*?)<\/select>/) || [])[1] || '';
  check('editor stack: the select shows the entry\'s own type', /value="homework_key" selected/.test(keySel)
        && !/value="homework" selected/.test(keySel));
  check('editor stack: a listed entry says which tab lists it',
        /mod_hw1[\s\S]*?Listed on the <strong>Homeworks<\/strong> tab/.test(eStack)
        && /mod_r1[\s\S]*?Listed on the <strong>Reports &amp; Tests<\/strong> tab/.test(eStack));
  const w1Card = eStack.slice(eStack.indexOf('data-mod-id="mod_w1"'), eStack.indexOf('data-mod-id="mod_hw1"'));
  check('editor stack: a plain module says nothing about tabs', w1Card.length > 0 && !w1Card.includes('Listed on the'));
  check('editor stack: lesson numbers skip the typed entries (Week 2 is lesson 2)',
        /mod_w2[\s\S]*?<span class="cb-mod-card-num">2<\/span>/.test(eStack));

  const eHw = builder.renderTypedModulesBody(true, hwSec);
  eq('editor Homeworks list: both entries, each with a Visible box',
     (eHw.match(/class="cb-mod-published"/g) || []).length, 2);
  check('editor Homeworks list: no add / delete / reorder — the stack owns those',
        !eHw.includes('cb-mod-add') && !eHw.includes('cb-mod-delete') && !eHw.includes('cb-mod-move'));
  check('editor Homeworks list: says where the entry is managed', eHw.includes('From <strong>Learning Modules</strong>'));
}

/* 7c. a class with no Homeworks tab at all: a public one is made before the
   first gated tab, and Reports & Tests then lands right after it. */
{
  const tabs = [
    { id: 't1', name: 'Course', sections: [{ id: 'blk_mod', key: 'modules' }] },
    { id: 't2', name: 'Admin', adminOnly: true, sections: [] }
  ];
  const data = { modules: [
    { id: 'm1', sectionId: 'blk_mod', htmlFile: 'a.html', order: 0, type: 'homework', published: true }
  ]};
  builder.load(tabs, data);
  eq('ensure: no Homeworks tab → a new public one before the admin tab',
     builder.ensureTypedModuleTabs(), ['Homeworks tab']);
  eq('ensure: tab order', tabs.map(t => t.name), ['Course', 'Homeworks', 'Admin']);
  data.modules.push({ id: 'm2', sectionId: 'blk_mod', htmlFile: 'r.html', order: 1, type: 'report', published: true });
  builder.ensureTypedModuleTabs();
  eq('ensure: Reports & Tests lands right after the Homeworks tab it just made',
     tabs.map(t => t.name), ['Course', 'Homeworks', 'Reports & Tests', 'Admin']);
}

/* A tab merely NAMED like homework is reused rather than duplicated. */
{
  const tabs = [
    { id: 't1', name: 'Lessons',  sections: [{ id: 'blk_mod', key: 'modules' }] },
    { id: 't2', name: 'Homework', sections: [] }
  ];
  builder.load(tabs, { modules: [{ id: 'm1', sectionId: 'blk_mod', htmlFile: 'k.html', order: 0, type: 'homework_key' }] });
  builder.ensureTypedModuleTabs();
  eq('ensure: a tab named like Homework is reused', tabs[1].sections.map(s => s.key), ['homeworkModules']);
  eq('ensure: no extra tab', tabs.length, 2);
}

/* Nothing typed → nothing made; teacher-classes → untouched. */
{
  const tabs = [{ id: 't1', sections: [{ id: 'blk_mod', key: 'modules' }] }];
  builder.load(tabs, { modules: [{ id: 'm1', sectionId: 'blk_mod', htmlFile: 'a.html', order: 0 }] });
  eq('ensure: no typed entries → nothing made', builder.ensureTypedModuleTabs(), []);
  eq('ensure: tabs untouched', tabs.length, 1);

  const tc = [];
  builder.load(tc, { modules: [{ id: 'optics--hw', htmlFile: 'hw.html', order: 0, type: 'homework', published: true }] });
  eq('ensure: teacher-class (tabs: []) is left alone even with a typed entry', builder.ensureTypedModuleTabs(), []);
  eq('ensure: teacher-class gains no tab', tc.length, 0);
}

/* 7d. the viewer: prev/next follow the LIST the student came from. */
{
  const schedule = {
    tabs: [{ id: 't1', sections: [{ id: 'blk_mod', key: 'modules' }] }],
    modules: [
      { id: 'mod_pre',  sectionId: 'blk_mod', htmlFile: 'pre.html', folder: 'f', order: -1, published: true, title: 'Pretest', type: 'pretest' },
      { id: 'mod_w1',   sectionId: 'blk_mod', htmlFile: '01.html',  folder: 'f', order: 0,  published: true, title: 'Week 1' },
      { id: 'mod_hw1',  sectionId: 'blk_mod', htmlFile: 'hw1.html', folder: 'f', order: 1,  published: true, title: 'HW 1', type: 'homework' },
      { id: 'mod_key1', sectionId: 'blk_mod', htmlFile: 'k1.html',  folder: 'f', order: 2,  published: true, title: 'HW 1 key', type: 'homework_key' },
      { id: 'mod_w2',   sectionId: 'blk_mod', htmlFile: '02.html',  folder: 'f', order: 3,  published: true, title: 'Week 2' },
      { id: 'mod_r1',   sectionId: 'blk_mod', htmlFile: 'r1.html',  folder: 'f', order: 4,  published: true, title: 'Report 1', type: 'report' },
      { id: 'mod_t1',   sectionId: 'blk_mod', htmlFile: 't1.html',  folder: 'f', order: 5,  published: true, title: 'Test 1', type: 'test' },
      { id: 'mod_w3',   sectionId: 'blk_mod', htmlFile: '03.html',  folder: 'f', order: 6,  published: true, title: 'Week 3' }
    ]
  };
  let r = openModule(schedule, 'mod_w1', 'c1');
  eq('viewer: a lesson\'s Next skips the homework and the key', [r.prev, r.next], ['mod_pre', 'mod_w2']);
  r = openModule(schedule, 'mod_w2', 'c1');
  eq('viewer: Week 2 → Week 3 skips the report and the test', [r.prev, r.next], ['mod_w1', 'mod_w3']);
  r = openModule(schedule, 'mod_hw1', 'c1');
  eq('viewer: a homework walks the Homeworks list only', [r.prev, r.next], [null, 'mod_key1']);
  r = openModule(schedule, 'mod_key1', 'c1');
  eq('viewer: the key\'s Prev is the homework, its Next is nothing', [r.prev, r.next], ['mod_hw1', null]);
  r = openModule(schedule, 'mod_r1', 'c1');
  eq('viewer: a report walks Reports & Tests only', [r.prev, r.next], [null, 'mod_t1']);
  eq('viewer: a typed entry still loads its own file', r.src, 'modules/f/r1.html?class=c1&mod=mod_r1');

  const stack = schedule.modules.filter(m => !builder.moduleHomeKey(m));
  eq('progress: lesson numbers count only modules (Week 2 is lesson 2 of 3)',
     builder.moduleProgressLabel(stack[2], stack, 2), 'Lesson 2 of 3');
  eq('progress: the pretest is named, not numbered', builder.moduleProgressLabel(stack[0], stack, 0), 'Pretest');
  const hw = schedule.modules.filter(m => builder.moduleHomeKey(m) === 'homeworkModules');
  eq('progress: a listed type reads by its label', builder.moduleProgressLabel(hw[1], hw, 1), 'Homework key · 2 of 2');
  eq('progress: notes are named', builder.moduleProgressLabel({ kind: 'notes' }, stack, 0), 'Instructor notes');
}

/* 7e. "any module i upload should have a type attached to it to autosort them
   upon load" — the type is guessed from the file name + title, prefilled in
   the picker, read as the effective type everywhere, and stamped at load. */
{
  const g = builder.guessModuleType;
  // the real BME 466 catalog
  eq('guess: hw-00-pretest → pretest', g('hw-00-pretest.html', "Pretest — Where You're Starting From (HW-00, BME 466/566)"), 'pretest');
  eq('guess: Week 1 lesson → module', g('01-diffusion-why-anything-moves.html', 'Diffusion — Why Anything Moves at All (Week 1, BME/AME 466/566)'), 'module');
  eq('guess: hw1-… "Homework 1 — Assignment (read first)" → homework', g('hw1-transport-problems.html', 'Homework 1 — Assignment (read first)'), 'homework');
  eq('guess: hw-01-… bench → homework', g('hw-01-transport-problems.html', 'Homework 1 — Transport Problems: Your Own Bench'), 'homework');
  eq('guess: HW1-student-key "Worked solutions" → homework_key', g('HW1-student-key.html', 'HW1 — Worked solutions'), 'homework_key');
  eq('guess: report-01-journal-review → report', g('report-01-journal-review.html', 'Report 1 — Read & Rebuild (journal review)'), 'report');
  eq('guess: a case REVIEW is not a report', g('R1-case-review-cf-mucus.html', 'Case Review — Why the Antibiotic Never Arrives'), 'module');
  eq('guess: a paper module is a module', g('P1-egfr-beyond-the-membrane.html', 'Beyond the Membrane — EGFR Signaling, Read Closely (Paper Module P1)'), 'module');
  eq('guess: "Key concepts" lesson is NOT a key', g('03-key-concepts.html', 'Key concepts of diffusion'), 'module');
  eq('guess: midterm → test', g('midterm-2026.html', 'Midterm — take-home'), 'test');
  eq('guess: "Pretest" does not read as a test', g('hw-00-pretest.html', 'Pretest'), 'pretest');
  eq('guess: unknown → module', g('overview.html', 'Overview'), 'module');
  eq('guess: nothing → module', g(undefined, undefined), 'module');

  // the effective type: an untyped entry reads as its guess; explicit wins
  eq('effective: untyped homework file reads as homework', builder.moduleType({ htmlFile: 'hw-02-reading.html', title: 'Homework 2' }), 'homework');
  eq('effective: explicit module beats the guess', builder.moduleType({ htmlFile: 'hw-02-reading.html', title: 'Homework 2', type: 'module' }), 'module');
  eq('effective: untyped homework lists on Homework & Keys', builder.moduleHomeKey({ htmlFile: 'hw-02-reading.html' }), 'homeworkModules');

  // stamped at load, so the editor select shows it and it persists on save
  const tabs = [{ id: 't1', name: 'Course', sections: [{ id: 'blk_mod', key: 'modules' }] }];
  const data = { modules: [
    { id: 'm_pre', sectionId: 'blk_mod', htmlFile: 'hw-00-pretest.html', title: 'Pretest', order: -1, published: true },
    { id: 'm_w1',  sectionId: 'blk_mod', htmlFile: '01.html', title: 'Week 1', order: 0, published: true },
    { id: 'm_hw1', sectionId: 'blk_mod', htmlFile: 'hw-01-x.html', title: 'Homework 1', order: 1, published: true },
    { id: 'm_n',   sectionId: 'blk_mod', htmlFile: 'notes.html', title: 'HW notes', order: 2, kind: 'notes' },
    { id: 'm_r1',  sectionId: 'blk_mod', htmlFile: 'report-01.html', title: 'Report 1', order: 3, published: true, type: 'module' }
  ]};
  builder.load(tabs, data);
  builder.ensureModuleTypes();
  eq('stamp: untyped entries get their guess', data.modules.slice(0, 3).map(m => m.type), ['pretest', 'module', 'homework']);
  check('stamp: notes are left alone', !('type' in data.modules[3]));
  eq('stamp: an explicit type is never second-guessed', data.modules[4].type, 'module');
  eq('stamp → tabs: the Homeworks tab follows on the same load', builder.ensureTypedModuleTabs(), ['Homeworks tab']);
  eq('stamp → tabs: the homework is on it', builder.modulesForTypedSection('homeworkModules').map(m => m.id), ['m_hw1']);

  // teacher-class: untouched
  const tc = { modules: [{ id: 'optics--hw', htmlFile: 'hw-01.html', title: 'Homework 1', order: 0 }] };
  const before = JSON.stringify(tc);
  builder.load([], tc);
  builder.ensureModuleTypes();
  eq('stamp: teacher-class (tabs: []) gets no type stamped', JSON.stringify(tc), before);

  // the viewer reads the doc straight from Firestore — before the first save
  // nothing has a type, and prev/next must already agree with the class page
  const schedule = {
    tabs: [{ id: 't1', sections: [{ id: 'blk_mod', key: 'modules' }] }],
    modules: [
      { id: 'mod_w1',  sectionId: 'blk_mod', htmlFile: '01.html',     folder: 'f', order: 0, published: true, title: 'Week 1' },
      { id: 'mod_hw1', sectionId: 'blk_mod', htmlFile: 'hw-01.html',  folder: 'f', order: 1, published: true, title: 'Homework 1' },
      { id: 'mod_key', sectionId: 'blk_mod', htmlFile: 'HW1-key.html', folder: 'f', order: 2, published: true, title: 'HW1 — Worked solutions' },
      { id: 'mod_w2',  sectionId: 'blk_mod', htmlFile: '02.html',     folder: 'f', order: 3, published: true, title: 'Week 2' }
    ]
  };
  let r = openModule(schedule, 'mod_w1', 'c1');
  eq('viewer, unsaved doc: Week 1 → Week 2 skips the guessed homework + key', [r.prev, r.next], [null, 'mod_w2']);
  r = openModule(schedule, 'mod_hw1', 'c1');
  eq('viewer, unsaved doc: the homework walks to its key', [r.prev, r.next], [null, 'mod_key']);
}

/* ── verdict ─────────────────────────────────────────────────────────────── */
console.log(`\nmodule placements: ${pass} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
