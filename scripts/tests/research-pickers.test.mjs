/* research-pickers.test.mjs — V3.717 (Grants become a level)
 *
 *   node scripts/tests/research-pickers.test.mjs
 *
 * The focus pickers over that same graph: Team Focus's semester dropdown
 * (grants and nothing else) and My Week's two-step cascade (pick the grant,
 * then optionally the aim or output under it). focus-areas.js is evaluated
 * in a vm with firebridge and ROADMAP_DATA stubbed.
 *
 * These caught a real bug during V3.717: analysis rows were being built
 * without their card's `links`, so every analysis fell into the "not under
 * a grant" bucket while its own card sat in the correct one — invisible
 * except by driving it.
 */

import fs from 'fs';
import vm from 'vm';

const docs = [
  { id:'tfm',   data:{ level:'specialty', title:'TFM', icon:'📐' } },
  { id:'tissue',data:{ level:'concept',   title:'Tissue engineering', links:{ specialty_ids:['tfm'] } } },
  { id:'r01',   data:{ level:'grant', title:'NIH R01', links:{ concept_ids:['tissue'] } } },
  { id:'nsf',   data:{ level:'grant', title:'NSF CAREER', links:{ concept_ids:['tissue'] } } },
  { id:'aim1',  data:{ level:'aim', title:'Aim 1', links:{ grant_ids:['r01'] },
                       roadmap:{ experiments:[{ id:'e1', title:'Sweep', analyses:[
                         { id:'a1', title:'Stiffness fit', status:'open' },
                         { id:'a2', title:'Done one',      status:'done' }] }] } } },
  { id:'pap',   data:{ level:'output', title:'Paper A', links:{ aim_ids:['aim1'] } } },
  { id:'solo',  data:{ level:'output', title:'Unattached paper', links:{} } },
  { id:'gone',  data:{ level:'aim', title:'Archived aim', status:'archived', links:{ grant_ids:['r01'] } } },
];

const ctx = {
  window: {}, console, DOMParser: class {}, Node: {},
  firebridge: {
    db: () => ({ collection: () => ({ get: async () => ({ docs: docs.map(d => ({ id: d.id, data: () => d.data })) }) }) }),
    getUser: () => ({ uid: 'u1' }),
  },
};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync('rm/js/research-data.js', 'utf8'), ctx);
ctx.RESEARCH_DATA = ctx.window.RESEARCH_DATA;
// roadmap-data.js supplies flattenAnalyses; stub just that.
ctx.window.ROADMAP_DATA = ctx.ROADMAP_DATA = {
  flattenAnalyses: (rm) => (rm?.experiments || []).flatMap(e =>
    (e.analyses || []).map(a => ({
      analysis: a, analysis_id: a.id, analysis_title: a.title,
      experiment_id: e.id, experiment_title: e.title,
    }))),
};
vm.runInContext(fs.readFileSync('rm/js/focus-areas.js', 'utf8'), ctx);
const FA = ctx.window.FOCUS_AREAS;

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + '\n       got  ' + g + '\n       want ' + w); }
};

const rows = await FA.listFociForPicker();

console.log('listFociForPicker');
eq('archived cards are dropped', rows.some(r => r.id === 'gone'), false);
eq('a DONE analysis is not pickable', rows.some(r => r.analysis_id === 'a2'), false);
eq('an OPEN analysis is', rows.some(r => r.analysis_id === 'a1'), true);
eq('rows sort by the five-level chain',
   rows.filter(r => !r.analysis_id).map(r => r.level),
   ['specialty','concept','grant','grant','aim','output','output']);

console.log('\nlistGrantsForPicker (Team Focus semester picker)');
const grants = await FA.listGrantsForPicker();
eq('grants only', grants.map(g => g.id), ['r01','nsf']);
eq('no analysis rows leak in', grants.some(g => g.analysis_id), false);

console.log('\nlistGrantChildrenForPicker (My Week dropdown 2)');
const kids = await FA.listGrantChildrenForPicker('r01');
eq('the aim, its analysis, and the output via that aim',
   kids.map(k => k.key), ['aim1','aim1::a1','pap']);
eq('an unattached output is excluded', kids.some(k => k.id === 'solo'), false);
eq('a grant with no children is empty', await FA.listGrantChildrenForPicker('nsf'), []);
eq('no grant id → nothing', await FA.listGrantChildrenForPicker(null), []);

console.log('\nrowsByGrant (optgroup buckets)');
const groups = await FA.rowsByGrant(rows);
eq('grant buckets first, unattributed last',
   groups.map(g => g.grant ? g.grant.id : null), ['r01','nsf',null]);
eq('r01 bucket holds the grant, its aim, the analysis and the output',
   groups.find(g => g.grant?.id === 'r01').rows.map(r => r.key),
   ['r01','aim1','aim1::a1','pap']);
eq('specialty/concept/solo fall to the null bucket',
   groups.find(g => !g.grant).rows.map(r => r.id), ['tfm','tissue','solo']);

console.log('\ngrantOfRow');
eq('an aim resolves to its grant', await FA.grantOfRow(rows.find(r => r.key === 'aim1')), 'r01');
eq('an output resolves VIA its aim', await FA.grantOfRow(rows.find(r => r.key === 'pap')), 'r01');
eq('a grant resolves to itself',    await FA.grantOfRow(rows.find(r => r.key === 'r01')), 'r01');
eq('a concept is indirect → null',  await FA.grantOfRow(rows.find(r => r.key === 'tissue')), null);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
