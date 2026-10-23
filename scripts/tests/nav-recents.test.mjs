#!/usr/bin/env node
/* V3.809 — the bar's two stores and its chip selection, as pure logic.
 *
 *   node scripts/tests/nav-recents.test.mjs
 *
 * Loads rm/js/nav.js into a vm with a stub window/document/localStorage
 * (no Firebase, no DOM rendering — DOMContentLoaded never fires here) and
 * exercises NavRecents (frecency), NavPins (mirror + defaults), the
 * personal chip selection, and the palette's text scorer. */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let failures = 0, passes = 0;
function ok(cond, msg) { if (cond) { passes++; } else { failures++; console.error('  ✗ ' + msg); } }
function eq(a, b, msg) { ok(JSON.stringify(a) === JSON.stringify(b), msg + ' — got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b)); }

/* ── stub browser ── */
function makeStorage() {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)),
           removeItem: k => m.delete(k), clear: () => m.clear() };
}
function makeContext(opts = {}) {
  const localStorage = makeStorage();
  const sessionStorage = makeStorage();
  const listeners = {};
  const stubEl = () => ({ className: '', dataset: {}, style: {}, children: [], appendChild() {}, addEventListener() {},
    setAttribute() {}, querySelector: () => null, querySelectorAll: () => [], classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, remove() {} });
  const document = {
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    querySelector: () => null, querySelectorAll: () => [],
    createElement: stubEl, head: stubEl(), body: Object.assign(stubEl(), { prepend() {}, contains: () => false }),
    documentElement: { dataset: {} }, readyState: 'complete', getElementById: () => null,
  };
  const window = {
    name: '', location: { pathname: opts.pathname || '/rm/pages/tasks.html', search: opts.search || '', hash: '', origin: 'http://localhost' },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    dispatchEvent() { return true; },
    localStorage, sessionStorage, document,
    navigator: { platform: 'MacIntel' },
    CustomEvent: class { constructor(t, i) { this.type = t; this.detail = i && i.detail; } },
    URL, URLSearchParams, console, Date, Math, JSON, Set, Map, Array, Object, String, Number, Promise,
    requestIdleCallback: () => {}, setTimeout: () => 0,
    ICON: { el: stubEl, svg: () => '<svg></svg>', label: n => n, render: () => '', has: () => true },
  };
  window.window = window;
  window.self = window;
  const ctx = vm.createContext(window);
  return { ctx, localStorage, listeners };
}
function load(ctx, file) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), ctx, { filename: file });
}

/* ── NavRecents ── */
{
  const { ctx } = makeContext();
  load(ctx, 'rm/js/nav.js');
  const R = vm.runInContext('NavRecents', ctx);
  const DAY = 86400000, t0 = Date.parse('2026-10-19T12:00:00Z');
  console.log('NavRecents');
  R.record('tasks', t0);
  R.record('tasks', t0 + 60000);
  R.record('chat', t0);
  let list = R.list(t0 + 60000);
  eq(list.map(r => r.id), ['tasks', 'chat'], 'two visits outrank one');
  ok(Math.abs(list[0].score - 2) < 0.01, 'back-to-back visits sum to 2 (got ' + list[0].score + ')');
  // a week later tasks has decayed to ~1; a fresh visit to chat makes it ~1.5 → chat leads
  R.record('chat', t0 + 7 * DAY);
  list = R.list(t0 + 7 * DAY);
  eq(list.map(r => r.id), ['chat', 'tasks'], 'half-life: one fresh visit beats two week-old ones');
  ok(Math.abs(list[1].score - 1) < 0.02, 'two visits halve to ~1 after 7 days (got ' + list[1].score + ')');
  // cap
  for (let i = 0; i < 50; i++) R.record('page-' + i, t0 + 8 * DAY + i);
  ok(Object.keys(R._read().pages).length <= 40, 'store capped at 40 pages');
  ok(R._read().pages['page-49'], 'the newest page survives the prune');
  ok(!R._read().pages['tasks'], 'the oldest page is pruned first');
  // seed
  const { ctx: c2 } = makeContext();
  load(c2, 'rm/js/nav.js');
  const R2 = vm.runInContext('NavRecents', c2);
  ok(R2.isEmpty() && !R2.isSeeded(), 'fresh store is empty and unseeded');
  const added = R2.seed([{ id: 'library', weight: 12, lastMs: t0 - DAY }, { id: 'pmr', weight: 3, lastMs: t0 - 3 * DAY }], t0);
  eq(added, 2, 'seed adds both pages');
  eq(R2.list(t0).map(r => r.id), ['library', 'pmr'], 'seeded pages rank by weight·decay');
  ok(R2.isSeeded(), 'seeded flag set');
  eq(R2.seed([{ id: 'library', weight: 99 }], t0), 0, 'seed never overwrites an existing page');
  eq(R2.seed([], t0), 0, 'empty seed still marks seeded');
  R2.forget('pmr');
  eq(R2.list(t0).map(r => r.id), ['library'], 'forget removes a page');
}

/* ── NavPins ── */
{
  const { ctx } = makeContext();
  load(ctx, 'rm/js/nav.js');
  const P = vm.runInContext('NavPins', ctx);
  console.log('NavPins');
  eq(P.effective(), ['my-week', 'tasks', 'chat'], 'defaults when nothing is stored');
  ok(P.local() === null, 'defaults are not written to the mirror');
  ok(P.toggle('library') === true, 'toggle on returns true');
  eq(P.effective(), ['my-week', 'tasks', 'chat', 'library'], 'pin appends');
  ok(P.toggle('tasks') === false, 'toggle off returns false');
  eq(P.effective(), ['my-week', 'chat', 'library'], 'unpin removes a default too');
  P.set(['chat', 'chat', '', 'pmr'], { silent: true });
  eq(P.effective(), ['chat', 'pmr'], 'set dedupes and drops blanks');
  P.set([], { silent: true });
  eq(P.effective(), [], 'an explicit empty list is NOT replaced by the defaults');
  // V3.812 — dirty flag: a user toggle is dirty until the cloud write lands; a cloud pull is clean
  ok(P.isDirty() === false, 'a silent (cloud) set leaves the mirror clean');
  P.toggle('pmr');
  ok(P.isDirty() === true, 'a toggle marks the mirror dirty (no firebridge → nothing can clear it)');
  P.set(['pmr'], { silent: true });
  ok(P.isDirty() === false, 'a later cloud set clears it');
}

/* ── personal chip selection ── */
{
  const { ctx } = makeContext({ pathname: '/rm/pages/library.html', search: '?tab=comments' });
  load(ctx, 'rm/js/nav.js');
  console.log('chip selection');
  const sel = vm.runInContext(`(() => {
    NavPins.set(['my-week', 'tasks', 'nonexistent-page', 'dashboard'], { silent: true });
    const now = Date.now();
    ['protocols', 'protocols', 'protocols', 'meetings', 'meetings', 'tasks', 'split-view'].forEach(id => NavRecents.record(id, now));
    return _navPersonalChipIds(_wfBuildPageMap());
  })()`, ctx);
  eq(sel.cur, 'library__tab__comments', 'current page resolves to the ?tab registry id');
  eq(sel.ids.slice(0, 2), ['my-week', 'tasks'], 'pins first, in pin order; unknown ids and Home dropped');
  eq(sel.ids.slice(2, 4), ['protocols', 'meetings'], 'recents follow by frecency; pinned duplicates skipped');
  ok(sel.ids.indexOf('split-view') < 0, 'Split is never a chip');
  ok(sel.ids.indexOf('library__tab__comments') >= 0, 'the current page gets a seat even if never recorded');
  eq(Array.from(sel.pinned), ['my-week', 'tasks'], 'pinned set reports resolvable pins only');
  // cap keeps the current page
  const sel2 = vm.runInContext(`(() => {
    const now = Date.now();
    ['pmr','calendar','chat','huddle','equipment','inventory','compliance','chemicals','people','career','budget'].forEach(id => NavRecents.record(id, now));
    return _navPersonalChipIds(_wfBuildPageMap());
  })()`, ctx);
  eq(sel2.ids.length, 10, 'capped at NAV_MAX_CHIPS');
  ok(sel2.ids.indexOf('library__tab__comments') >= 0, 'the current page survives the cap');
  // current page outside the registry → null, no crash
  const { ctx: c3 } = makeContext({ pathname: '/rm/pages/library-paper.html', search: '?id=abc' });
  load(c3, 'rm/js/nav.js');
  const cur3 = vm.runInContext('_navCurrentPageId(_wfBuildPageMap())', c3);
  eq(cur3, null, 'a deep page (paper reader) is not a registry page');
  const cur4 = vm.runInContext('(() => { location.pathname="/rm/pages/library.html"; location.search="?tab=unknown"; return _navCurrentPageId(_wfBuildPageMap()); })()', c3);
  eq(cur4, 'library', 'an unknown ?tab falls back to the tab-less page');
}

/* ── NAV_ITEMS hygiene ── */
{
  const { ctx } = makeContext();
  load(ctx, 'rm/js/nav.js');
  console.log('NAV_ITEMS');
  const r = vm.runInContext(`(() => {
    const m = _wfBuildPageMap(); const missingIcon = [], missingDesc = [];
    m.forEach(p => { if (!p.icon) missingIcon.push(p.id); if (!NAV_PAGE_DESCRIPTIONS[p.id]) missingDesc.push(p.id); });
    return { n: m.size, missingIcon, missingDesc, home: m.get('dashboard') && m.get('dashboard').label };
  })()`, ctx);
  ok(r.n >= 55, 'page map has every nav page (' + r.n + ')');
  eq(r.missingIcon, [], 'every page has an icon');
  eq(r.missingDesc, [], 'every page has a blurb');
  eq(r.home, 'Home', 'Dashboard is labelled Home');
  // icon names must exist in icons.js
  const iconsSrc = fs.readFileSync(path.join(ROOT, 'rm/js/icons.js'), 'utf8');
  const m = iconsSrc.match(/var OUTLINE = (\{[\s\S]*?\});\s*\n/);
  const names = new Set(Object.keys(vm.runInNewContext('(' + m[1] + ')')));
  const bad = vm.runInContext('Array.from(_wfBuildPageMap().values()).map(p => p.icon)', ctx).filter(n => !names.has(n));
  eq(Array.from(new Set(bad)), [], 'every nav icon exists in icons.js');
}

/* ── palette scorer ── */
{
  const { ctx } = makeContext();
  load(ctx, 'rm/js/nav-palette.js');
  const score = vm.runInContext('NavPalette._scoreText', ctx);
  console.log('palette scorer');
  ok(score('lab', 'Lab Notebook', true) > score('note', 'Lab Notebook', true), 'prefix beats word-start');
  ok(score('note', 'Lab Notebook', true) > score('ebo', 'Lab Notebook', true), 'word-start beats substring');
  ok(score('ebo', 'Lab Notebook', true) > score('lnb', 'Lab Notebook', true), 'substring beats subsequence');
  eq(score('xyz', 'Lab Notebook', true), -1, 'no match is -1');
  eq(score('', 'Lab Notebook', true), 0, 'empty query scores 0 (neutral)');
  ok(score('pcrd', 'Pcard Helper', true) > score('pcrd', 'Protocols and card deck', true), 'tighter subsequence wins');
  eq(score('note', 'Course planning + outlines for current courses', false), -1, 'blurbs never match by subsequence');
  ok(score('note', 'Electronic lab notebook — daily entries', false) > 0, 'blurbs still match by substring');
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
