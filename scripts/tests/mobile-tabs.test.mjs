/* mobile-tabs.test.mjs — node scripts/tests/mobile-tabs.test.mjs
 * V3.840/V3.847: the app's page catalog, the ☰ fan (Scan · the quick links ·
 * More), its one-or-two-arc layout and the saved-list normaliser.
 * mobile-shell.js exports TABS_CORE before its app gate, so it loads in node
 * without a DOM. */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const T = require('../../rm/js/mobile-shell.js');

let pass = 0, fail = 0;
function eq(got, want, name) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log('  ok    ' + name); }
  else { fail++; console.log('  FAIL  ' + name + '\n        got  ' + g + '\n        want ' + w); }
}

console.log('── catalog ──');
const keys = T.CATALOG.map(t => t.key);
eq(keys.length, new Set(keys).size, 'keys are unique');
eq(T.CATALOG.filter(t => t.native).map(t => t.key), ['myday', 'focus', 'chat', 'tasks', 'library', 'inventory'], 'the six native webviews (TabRoute.swift TabKey)');
eq(T.DEFAULT_KEYS, ['myday', 'focus', 'chat', 'tasks', 'library', 'inventory'], 'the default quick links are the V3.835 six');
eq(T.MAX_TABS, 8, 'up to eight quick links');
eq(T.CATALOG.every(t => /^\/rm\/pages\/[a-z-]+\.html$/.test(t.href)), true, 'every href is an app page');
eq(T.CATALOG.every(t => t.match.test(t.href)), true, 'every page matches its own path');
eq(T.CATALOG.every(t => t.icon && t.label), true, 'icon + label on every entry');
eq(keys.includes('scan') && keys.includes('actions'), true, 'the scan tool and the actions page are catalog pages');
eq(T.CATALOG.length >= 16, true, 'the More pages (Notebook, Scheduler, Research, Meetings, Protocols, Buying, Equipment, PMR, Settings) are in the catalog');

console.log('── the ☰ fan ──');
eq(T.SCAN_TOOL.key === 'scan' && T.SCAN_TOOL.fresh === true && T.SCAN_TOOL.fixed === true && /scan\.html$/.test(T.SCAN_TOOL.href), true, 'Scan a label is fixed and always navigates fresh');
eq(T.MORE_TOOL.key === 'more' && T.MORE_TOOL.more === true && T.MORE_TOOL.fixed === true, true, 'More is fixed');
eq(T.fanItems(T.DEFAULT_KEYS).map(t => t.key), ['scan', 'myday', 'focus', 'chat', 'tasks', 'library', 'inventory', 'more'], 'fan = Scan · the quick links in order · More');
eq(T.fanItems(['scan', 'chat']).map(t => t.key), ['scan', 'chat', 'more'], 'a saved Scan is not doubled');
eq(T.normalizeKeys(['scan', 'chat']), ['chat'], 'Scan is never a quick link (it is always in the fan)');
eq(T.fanItems([]).length, 8, 'an empty list falls back to the default six (+2)');
eq(T.fanItems(['myday', 'focus', 'chat', 'tasks', 'library', 'inventory', 'notebook', 'pmr']).length, 10, 'eight quick links → ten in the fan');

console.log('── ringLayout ──');
const deg = n => T.ringLayout(n).map(s => Math.round(s.deg));
const rings = n => T.ringLayout(n).map(s => s.ring);
eq(T.ringLayout(0), [], 'nothing → nothing');
eq(deg(1), [90], 'one item sits straight above');
eq(deg(3), [160, 90, 20], 'three spread 160° → 20°');
eq(rings(4), [1, 1, 1, 1], 'four fit one arc');
eq(rings(5), [1, 1, 1, 1, 2], 'five: four inner, one outer');
eq(deg(5)[4], 90, 'a lone outer item sits straight above');
eq(rings(8), [1, 1, 1, 1, 2, 2, 2, 2], 'eight: four + four');
eq(deg(8).slice(4), [150, 110, 70, 30], 'the outer arc spreads 150° → 30°');
eq(rings(10), [1, 1, 1, 1, 2, 2, 2, 2, 2, 2], 'ten: four + six');
eq(T.ringLayout(10).every(s => s.deg >= 20 && s.deg <= 160), true, 'every item stays above the button (20° … 160°)');

console.log('── match families ──');
const k = href => (T.CATALOG.find(t => t.match.test(href)) || {}).key || '';
eq([k('/rm/pages/my-day.html'), k('/rm/pages/my-week.html')], ['myday', 'myday'], 'both My Week names');
eq([k('/rm/pages/tasks-inbox.html'), k('/rm/pages/lab-tasks.html')], ['tasks', ''], 'tasks family, not lab-tasks (same as TabRoute.swift)');
eq([k('/rm/pages/library-mobile-paper.html'), k('/rm/pages/inventory-labels.html'), k('/rm/pages/notebook.html')], ['library', 'inventory', 'notebook'], 'library, inventory and notebook families');
eq([k('/rm/pages/scan.html'), k('/rm/pages/actions.html')], ['scan', 'actions'], 'scan and actions');

console.log('── normalizeKeys ──');
eq(T.normalizeKeys(['chat', 'bogus', 'chat', 'notebook']), ['chat', 'notebook'], 'unknown and repeated keys drop, order kept');
eq(T.normalizeKeys([]), T.DEFAULT_KEYS, 'empty → default');
eq(T.normalizeKeys('chat'), T.DEFAULT_KEYS, 'not a list → default');
eq(T.normalizeKeys(['myday', 'focus', 'chat', 'tasks', 'library', 'inventory', 'notebook', 'settings', 'pmr', 'research']).length, 8, 'capped at MAX_TABS');
eq(T.normalizeKeys(['settings']), ['settings'], 'one page is a valid list');
eq(T.byKey('procurement').label, 'Buying', 'byKey');

console.log(`mobile-tabs: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
