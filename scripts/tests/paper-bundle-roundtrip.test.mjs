/* paper-bundle-roundtrip.test.mjs — V3.742 (bundle checkout round trip)
 *
 *   node scripts/tests/paper-bundle-roundtrip.test.mjs
 *
 * The papers list can now check a draft out as a .paperbundle.zip and import
 * it BACK INTO THE SAME PAPER (PaperTreeBuild.buildInto with replace:true).
 * Because that replaces the whole tree, anything the exporter writes that the
 * builder ignores is silently deleted on every round trip. These fixtures pin
 * the contract: serialize → buildInto → serialize must be byte-identical for a
 * paper that uses every shape we have — table cells (Y.Map<Y.Text>) and
 * captions, figure subfigures, paragraph skeleton_items, section
 * style_overrides, the equation library, unplaced figures/tables and the value
 * library with its nested snapshot map.
 *
 * Pure node: paper-export-bundle.js and paper-tree-build.js are evaluated in a
 * vm against a stub window; Yjs comes from functions/node_modules. Nothing here
 * touches Firestore.
 */

import fs from 'fs';
import vm from 'vm';
import { createRequire } from 'module';
import assert from 'assert';

const require = createRequire(import.meta.url);
const Y = require('../../functions/node_modules/yjs');

const ctx = { window: {}, console, document: {}, firebridge: undefined };
ctx.window.PaperSchemas = {
  shortId: (p) => p + Math.random().toString(36).slice(2, 10),
  newValueEntry: (v) => Object.assign({
    id: '', key: '', kind: 'text', note: '', value: '', num: null, unit: '', sigfigs: null,
    inv_id: '', inv_kind: 'item', snapshot: { name: '', vendor: '', catalogue_number: '' },
    format: '', refreshed_at: null,
  }, v || {}),
};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync('rm/js/paper-export-bundle.js', 'utf8'), ctx);
vm.runInContext(fs.readFileSync('rm/js/paper-tree-build.js', 'utf8'), ctx);
const Bundle = ctx.window.PaperExportBundle;
const Build = ctx.window.PaperTreeBuild;

let pass = 0, fail = 0;
// Values built inside the vm carry that realm's Array/Object prototypes, so
// assert.deepStrictEqual rejects structurally-equal data. Compare by JSON.
const J = (v) => JSON.stringify(v);
function same(got, want) {
  if (J(got) !== J(want)) throw new Error('got  ' + J(got) + '\n       want ' + J(want));
}
function ok(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.message || e)); }
}

/* ── fixture: a paper exercising every shape ── */
const fixture = {
  tree: {
    meta: { title: 'Granule coating' },
    sections: [
      {
        id: 'sec-abs', kind: 'abstract', label: 'Abstract', order: 0, status: 'complete',
        style_overrides: { font: 'serif', columns: 1 },
        completed_at: '2026-09-01T00:00:00.000Z', completed_by: 'Alex',
        revision_by: null, revision_at: null, special: null, special_render: null,
        appendix: false, ref_label: 'abs', uploaded_file: null,
        children: [
          {
            id: 'p-1', kind: 'paragraph', status: 'draft',
            skeleton: 'legacy outline',
            skeleton_items: [
              { id: 'sk-1', depth: 0, text: 'Claim one [@smith2020]', claim_id: 'cl-9' },
              { id: 'sk-2', depth: 1, text: 'support', claim_id: null },
            ],
            body: 'Body text with a value [!val:Tg] and cite [@smith2020].',
            attrs: {},
          },
        ],
      },
      {
        id: 'sec-res', kind: 'results', label: 'Results', order: 1, status: 'draft',
        style_overrides: {},
        completed_at: null, completed_by: null, revision_by: null, revision_at: null,
        special: null, special_render: null, appendix: false, ref_label: null, uploaded_file: null,
        children: [
          {
            id: 'tab-1', kind: 'table', status: 'draft', skeleton: '', skeleton_items: [], body: '',
            attrs: {
              rows: 2, cols: 2, numbered: true, label: 'tab:one', booktabs: true, header_row: true,
              cells: { __ytype: 'map', entries: {
                '0-0': { __ytype: 'text', value: 'A' }, '0-1': { __ytype: 'text', value: 'B' },
                '1-0': { __ytype: 'text', value: '1' }, '1-1': { __ytype: 'text', value: '2 [@doe2019]' },
              } },
              caption: { __ytype: 'text', value: 'Table caption' },
              align: 'lc',
            },
          },
          {
            id: 'fig-1', kind: 'figure', status: 'draft', skeleton: '', skeleton_items: [],
            body: 'Figure caption', attrs: {
              storage_path: 'paper-figures/granule-coating/abc123.png', hash: 'abc123', mime: 'image/png',
              width: 0.8, placement: 't', numbered: true, label: 'fig:one', span: 'column', lock: false,
              subfigures: { __ytype: 'array', items: [
                { __ytype: 'map', entries: { label: 'A', storage_path: 'paper-figures/granule-coating/def456.png' } },
                { __ytype: 'map', entries: { label: 'B', storage_path: 'paper-figures/granule-coating/789abc.png' } },
              ] },
            },
          },
          {
            id: 'eq-1', kind: 'equation', status: 'draft', skeleton: '', skeleton_items: [],
            body: 'E = mc^2', attrs: { display: true, numbered: true, label: 'eq:mass', span: 'column' },
          },
        ],
      },
    ],
  },
  equation_library: [{ id: 'eq-lib-1', name: 'stress', latex: '\\sigma = F/A', type: 'inline' }],
  value_library: [{
    id: 'v-1', key: 'Tg', kind: 'number', note: 'glass transition', value: '', num: 37.5, unit: '°C', sigfigs: 3,
    inv_id: '', inv_kind: 'item', snapshot: { name: '', vendor: '', catalogue_number: '' }, format: '', refreshed_at: null,
  }, {
    id: 'v-2', key: 'PDMS', kind: 'inventory', note: '', value: 'Sylgard 184', num: null, unit: '', sigfigs: null,
    inv_id: 'inv-77', inv_kind: 'item', snapshot: { name: 'Sylgard 184', vendor: 'Dow', catalogue_number: '184' },
    format: 'name', refreshed_at: '2026-08-01',
  }],
  figure_unplaced: [{
    id: 'fig-u1', kind: 'figure', status: 'draft', skeleton: '', skeleton_items: [], body: 'Unplaced',
    attrs: { storage_path: 'paper-figures/granule-coating/zzz.png', subfigures: { __ytype: 'array', items: [] } },
  }],
  table_unplaced: [],
};

function connFor(doc) { return { Y, yDoc: doc }; }
function buildFresh(bundle, opts) {
  const doc = new Y.Doc();
  doc.transact(() => Build.buildInto(doc.getMap('paper'), bundle, Y, opts || {}));
  return doc;
}
function normalize(tree) {
  // serialize() emits every optional field; the fixture omits none, so a
  // straight JSON compare is fair. Sort nothing — order is part of the contract.
  return JSON.parse(JSON.stringify(tree));
}
function asBundle(ser) {
  return {
    tree: { meta: { title: ser.title }, sections: ser.sections },
    equation_library: ser.equation_library, value_library: ser.value_library,
    figure_unplaced: ser.figure_unplaced, table_unplaced: ser.table_unplaced,
  };
}

console.log('build → serialize');
const doc1 = buildFresh(fixture);
const ser1 = Bundle.serialize(connFor(doc1));

ok('title survives', () => assert.strictEqual(ser1.title, 'Granule coating'));
ok('section + block ids preserved', () => {
  same(ser1.sections.map(s => s.id), ['sec-abs', 'sec-res']);
  same(ser1.sections[1].children.map(b => b.id), ['tab-1', 'fig-1', 'eq-1']);
});
ok('skeleton_items rebuilt (was dropped before V3.742)', () =>
  same(ser1.sections[0].children[0].skeleton_items, fixture.tree.sections[0].children[0].skeleton_items));
ok('style_overrides rebuilt (was dropped before V3.742)', () =>
  same(ser1.sections[0].style_overrides, { font: 'serif', columns: 1 }));
ok('empty style_overrides stays {}', () => same(ser1.sections[1].style_overrides, {}));
ok('value_library rebuilt incl. nested snapshot (was dropped before V3.742)', () =>
  same(ser1.value_library, fixture.value_library));
ok('table cells are Y.Map<Y.Text> + caption Y.Text', () => {
  const t = ser1.sections[1].children[0].attrs;
  assert.strictEqual(t.cells.__ytype, 'map');
  assert.strictEqual(t.cells.entries['1-1'].__ytype, 'text');
  assert.strictEqual(t.cells.entries['1-1'].value, '2 [@doe2019]');
  same(t.caption, { __ytype: 'text', value: 'Table caption' });
});
ok('figure subfigures are Y.Array<Y.Map>', () => {
  const f = ser1.sections[1].children[1].attrs;
  assert.strictEqual(f.subfigures.__ytype, 'array');
  assert.strictEqual(f.subfigures.items.length, 2);
  assert.strictEqual(f.subfigures.items[1].entries.label, 'B');
});
ok('whole tree round-trips byte-identical', () => {
  const want = normalize({
    title: fixture.tree.meta.title, sections: fixture.tree.sections,
    equation_library: fixture.equation_library, value_library: fixture.value_library,
    figure_unplaced: fixture.figure_unplaced, table_unplaced: fixture.table_unplaced,
  });
  same(normalize(ser1), want);
});

console.log('second generation: serialize → build → serialize is a fixed point');
const doc2 = buildFresh(asBundle(ser1));
const ser2 = Bundle.serialize(connFor(doc2));
ok('gen2 == gen1', () => same(normalize(ser2), normalize(ser1)));

console.log('replace mode (update in place)');
// Edit "in VSCode": change body text, edit a table cell, add a value, drop a section, retitle.
const edited = JSON.parse(JSON.stringify(asBundle(ser1)));
edited.tree.meta.title = 'Granule coating — revised';
edited.tree.sections[0].children[0].body = 'REVISED body [@smith2020].';
edited.tree.sections[1].children[0].attrs.cells.entries['1-1'].value = '99';
edited.tree.sections.splice(1, 1);                   // drop Results entirely
edited.value_library.push({ id: 'v-3', key: 'n', kind: 'number', note: '', value: '', num: 12, unit: '', sigfigs: null,
  inv_id: '', inv_kind: 'item', snapshot: { name: '', vendor: '', catalogue_number: '' }, format: '', refreshed_at: null });
edited.equation_library = [];
edited.figure_unplaced = [];

const live = buildFresh(fixture);                      // the paper as it sits in Firestore
const liveMap = live.getMap('paper');
let updatesSeen = 0;
live.on('update', () => { updatesSeen++; });
live.transact(() => Build.buildInto(liveMap, edited, Y, { replace: true }), 'import-build');
const ser3 = Bundle.serialize(connFor(live));

ok('replace is ONE Y update (atomic transact)', () => assert.strictEqual(updatesSeen, 1));
ok('title replaced, not appended', () => assert.strictEqual(ser3.title, 'Granule coating — revised'));
ok('sections replaced — dropped section is gone, none duplicated', () =>
  same(ser3.sections.map(s => s.id), ['sec-abs']));
ok('edited body landed', () => assert.strictEqual(ser3.sections[0].children[0].body, 'REVISED body [@smith2020].'));
ok('block id preserved through replace (comments still bind)', () =>
  assert.strictEqual(ser3.sections[0].children[0].id, 'p-1'));
ok('value added, none duplicated', () =>
  same(ser3.value_library.map(v => v.key), ['Tg', 'PDMS', 'n']));
ok('emptied libraries are empty (not stale)', () => {
  same(ser3.equation_library, []);
  same(ser3.figure_unplaced, []);
});
ok('replace result equals the edited bundle exactly', () =>
  same(normalize(ser3), normalize({
    title: edited.tree.meta.title, sections: edited.tree.sections,
    equation_library: [], value_library: edited.value_library, figure_unplaced: [], table_unplaced: [],
  })));

console.log('non-replace build stays append-only (create path unchanged)');
const live2 = buildFresh(fixture);
live2.transact(() => Build.buildInto(live2.getMap('paper'), asBundle(ser1), Y, {}));
ok('without replace, sections double (the historical behaviour the create path relies on for empty docs)', () =>
  assert.strictEqual(Bundle.serialize(connFor(live2)).sections.length, 4));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
