/* research-graph.test.mjs — V3.717 (Grants become a level)
 *
 *   node scripts/tests/research-graph.test.mjs
 *
 * The card graph behind the research map: specialty → concept → grant →
 * aim → output, children pointing UP via `links`, every parent list
 * DERIVED. Pure node fixtures — research-data.js is evaluated in a vm and
 * none of these tests touch Firestore.
 *
 * Why this file exists: attribution is derived, never stored. The grant
 * review's per-person roll-up, My Week's second dropdown and Team Focus's
 * picker all resolve "whose grant is this work under?" through
 * grantIdsForCard. If that walk is wrong, work lands under the wrong grant
 * — or silently under none — and nothing throws. The fixture deliberately
 * includes the awkward shapes: an aim serving two grants, an output that
 * reaches its grant only VIA an aim, and a legacy pre-V3.717 output still
 * hanging off a concept.
 */

import fs from 'fs';
import vm from 'vm';

// research-data.js is an IIFE that hangs itself off window; it only touches
// firebridge/DOM inside the read/write paths, which these tests don't call.
const ctx = { window: {}, console, DOMParser: class {}, Node: {} };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync('rm/js/research-data.js', 'utf8'), ctx);
const RD = ctx.window.RESEARCH_DATA;

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + '\n       got  ' + g + '\n       want ' + w); }
};

const card = (id, level, links = {}) => RD.hydrate({ id, level, links });

// specialty ← concept ← grant ← aim ← output
const map = [
  card('tfm', 'specialty'),
  card('gels', 'specialty'),
  card('tissue', 'concept', { specialty_ids: ['tfm', 'gels'] }),
  card('r01', 'grant', { concept_ids: ['tissue'] }),
  card('nsf', 'grant', { concept_ids: ['tissue'] }),
  card('aim1', 'aim', { grant_ids: ['r01'] }),
  card('aim2', 'aim', { grant_ids: ['r01', 'nsf'] }),   // an aim can serve two
  card('paper-a', 'output', { aim_ids: ['aim1'] }),      // reaches r01 via aim
  card('paper-b', 'output', { grant_ids: ['nsf'] }),     // direct
  card('legacy', 'output', { concept_ids: ['tissue'] }), // pre-V3.717 shape
];
const byId = Object.fromEntries(map.map(c => [c.id, c]));
const gids = id => RD.grantIdsForCard(byId[id], map);

console.log('grantIdsForCard');
eq('grant resolves to itself',        gids('r01'),      [{ id: 'r01', indirect: false }]);
eq('aim → its grant',                 gids('aim1'),     [{ id: 'r01', indirect: false }]);
eq('aim → both its grants',           gids('aim2'),     [{ id: 'r01', indirect: false }, { id: 'nsf', indirect: false }]);
eq('output → grant VIA its aim',      gids('paper-a'),  [{ id: 'r01', indirect: false }]);
eq('output → grant directly',         gids('paper-b'),  [{ id: 'nsf', indirect: false }]);
eq('concept → grants, flagged indirect', gids('tissue'), [{ id: 'r01', indirect: true }, { id: 'nsf', indirect: true }]);
eq('specialty attributes to nothing', gids('tfm'),      []);
eq('legacy output reaches no grant',  gids('legacy'),   []);

console.log('cardsUnderGrant');
eq('r01 gathers its aims + their outputs',
   RD.cardsUnderGrant(byId['r01'], map).map(c => c.id).sort(),
   ['aim1', 'aim2', 'paper-a', 'r01']);
eq('nsf gathers the shared aim + its direct output',
   RD.cardsUnderGrant(byId['nsf'], map).map(c => c.id).sort(),
   ['aim2', 'nsf', 'paper-b']);
eq('an indirect concept hit is NOT a member',
   RD.cardsUnderGrant(byId['r01'], map).some(c => c.id === 'tissue'), false);
eq('a non-grant card yields nothing', RD.cardsUnderGrant(byId['aim1'], map), []);

console.log('childrenOf / parentRefsOf');
eq('grant → its aims',        RD.childrenOf(byId['r01'], map, ['aim']).map(c => c.id), ['aim1', 'aim2']);
eq('concept → its grants',    RD.childrenOf(byId['tissue'], map, ['grant']).map(c => c.id), ['r01', 'nsf']);
eq('specialty → its concepts',RD.childrenOf(byId['tfm'], map, ['concept']).map(c => c.id), ['tissue']);
eq('aim parents',             RD.parentRefsOf(byId['aim2']), [{ id: 'r01', level: 'grant' }, { id: 'nsf', level: 'grant' }]);
eq('output parents in PARENTS order (aim before concept)',
   RD.parentRefsOf(byId['paper-a']), [{ id: 'aim1', level: 'aim' }]);
eq('specialty has no parents', RD.parentRefsOf(byId['tfm']), []);

/* V3.719 — an output may serve SEVERAL grants, directly or through the aims
 * it synthesizes, and the hub groups aims under the grant they belong to. */
console.log('outputs associate with one or more grants (V3.719)');
const multi = map.concat([
  card('paper-multi', 'output', { grant_ids: ['r01', 'nsf'] }),
  card('paper-mixed', 'output', { aim_ids: ['aim1'], grant_ids: ['nsf'] }),
]);
eq('an output can name two grants directly',
   RD.grantIdsForCard(multi.find(c => c.id === 'paper-multi'), multi),
   [{ id: 'r01', indirect: false }, { id: 'nsf', indirect: false }]);
eq('direct and via-aim grants both count, deduped and direct-first',
   RD.grantIdsForCard(multi.find(c => c.id === 'paper-mixed'), multi),
   [{ id: 'nsf', indirect: false }, { id: 'r01', indirect: false }]);
eq('an output the links modal can point at a grant', RD.PARENTS.output.indexOf('grant') !== -1, true);
eq('the grant pool writes links.grant_ids', RD.LINK_KEY.grant, 'grant_ids');
eq('grant_ids survives hydrate as an array',
   RD.hydrate({ level: 'output', links: { grant_ids: ['a', 'b'] } }).links.grant_ids, ['a', 'b']);
// The grouping the band does: bucket aims by the grant they resolve to.
eq('aims bucket under their own grant',
   ['r01', 'nsf'].map(g => map.filter(c => c.level === 'aim' &&
      RD.grantIdsForCard(c, map).some(h => h.id === g && !h.indirect)).map(c => c.id)),
   [['aim1', 'aim2'], ['aim2']]);

/* V3.720 — a grant carries its own bibliography pointer; V3.718's separate
 * `reference` card and level are gone. */
console.log('the grant carries its bibliography (V3.720)');
eq('there is no reference level', RD.LEVELS.reference, undefined);
eq('hydrate defaults ref_source to null', RD.hydrate({}).ref_source, null);
eq('a grant keeps its ref_source',
   RD.hydrate({ level: 'grant', ref_source: { kind: 'draft_citations', draft_id: 'd1' } }).ref_source,
   { kind: 'draft_citations', draft_id: 'd1' });

/* The bug this guards: a card written by a NEWER build carries a level this
 * one has never heard of. Coercing it to 'concept' (pre-V3.718) filed the
 * References card in the Concepts band for anyone on stale code. An unknown
 * level must keep its name so BANDS renders it NOWHERE, and every level
 * lookup must still answer. */
eq('an unknown level is NOT coerced to concept', RD.hydrate({ level: 'from-the-future' }).level, 'from-the-future');
eq('an unknown level belongs to no band',
   RD.BANDS.some(b => b.levels.indexOf('from-the-future') !== -1), false);
eq('levelMeta always answers', typeof RD.levelMeta('from-the-future').icon, 'string');
eq('levelMeta is exact for a known level', RD.levelMeta('grant').label, 'Grant');
eq('a missing level still defaults to concept', RD.hydrate({}).level, 'concept');

console.log('vocabulary');
eq('five levels in chain order', RD.LEVEL_ORDER, ['specialty','concept','grant','aim','output']);
eq('every level in the chain is renderable in some band',
   RD.LEVEL_ORDER.filter(l => !RD.BANDS.some(b => b.levels.indexOf(l) !== -1)), []);
eq('four hub bands', RD.BANDS.map(b => b.key), ['specialty','concept','grant','delivery']);
eq('the delivery band holds both', RD.BANDS[3].levels, ['aim','output']);
eq('grant lifecycle', RD.GRANT_STATUSES, ['in_preparation','submitted','awarded','completed']);
eq('every grant status has a pill', RD.GRANT_STATUSES.every(s => !!RD.STATUS_META[s]), true);
eq('a new grant starts in preparation', RD.DEFAULT_STATUS.grant, 'in_preparation');
eq('hydrate defaults the new link arrays',
   [RD.hydrate({}).links.grant_ids, RD.hydrate({}).links.aim_ids], [[], []]);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
