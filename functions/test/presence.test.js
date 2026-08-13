/* ================================================================
   presence.test.js — notification suppression fixtures (V3.596)
   ================================================================
   Plain node, no emulator, no deps:
       node functions/test/presence.test.js

   The gate's whole job is to be quiet in exactly ONE case — you are
   demonstrably looking at the thing right now — and to FAIL OPEN in
   every other case. So most fixtures below assert that the
   notification still goes out. Run this before every
   `firebase deploy --only functions` touching notify.js or presence.js.
   ================================================================ */

'use strict';

const P = require('../helpers/presence');

let pass = 0, fail = 0;
const failures = [];

function check(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; return; }
  fail++;
  failures.push(`${name}\n      got ${g}, want ${w}`);
}

// Fixed clock for isViewing (which takes `now` as an argument).
const NOW = Date.parse('2026-07-30T12:00:00Z');
const FRESH = NOW - 10 * 1000;        // within FRESH_MS (150s)
const STALE = NOW - 200 * 1000;       // beyond it

/* One surface: signed in on the chat page, watching channel A. */
function surface(over) {
  return {
    surfaces: {
      'dev-1': Object.assign({
        paths: ['/rm/pages/chat.html'],
        contextIds: ['chan-A'],
        visible: true,
        lastActiveAt: FRESH,
        client: 'web',
      }, over || {}),
    },
  };
}

const viewing = (doc, url) => P.isViewing(doc, P.surfaceKeyFromUrl(url), NOW);

/* ── url → surface key ──────────────────────────────────────── */
{
  check('chat url yields path + channel', P.surfaceKeyFromUrl('/rm/pages/chat.html?channel=chan-A'),
    { path: '/rm/pages/chat.html', contextId: 'chan-A' });
  check('equipment url has no context', P.surfaceKeyFromUrl('/rm/pages/equipment.html'),
    { path: '/rm/pages/equipment.html', contextId: null });
  check('huddle uses ?item=', P.surfaceKeyFromUrl('/rm/pages/huddle.html?kind=plan&item=p9').contextId, 'p9');
  check('marketing hash fallback is not an RM surface', P.surfaceKeyFromUrl('/#/apps'), null);
  check('missing url', P.surfaceKeyFromUrl(undefined), null);
  check('empty url', P.surfaceKeyFromUrl(''), null);

  check('trailing slash normalizes', P.normalizePath('/rm/pages/chat.html/'), '/rm/pages/chat.html');
  check('/rm normalizes to index', P.normalizePath('/rm'), '/rm/index.html');
  check('/rm/ normalizes to index', P.normalizePath('/rm/'), '/rm/index.html');
}

/* ── SUPPRESS: the only cases that may go quiet ─────────────── */
{
  check('watching that exact channel', viewing(surface(), '/rm/pages/chat.html?channel=chan-A'), true);
  check("'*' wildcard matches any context on the page",
    viewing(surface({ contextIds: ['*'] }), '/rm/pages/chat.html?channel=chan-Z'), true);
  check('context-less notif on the page it targets',
    viewing({ surfaces: { d: {
      paths: ['/rm/pages/equipment.html'], contextIds: ['*'], visible: true, lastActiveAt: FRESH,
    } } }, '/rm/pages/equipment.html'), true);
  check('ISO-string timestamp is accepted',
    viewing(surface({ lastActiveAt: new Date(FRESH).toISOString() }), '/rm/pages/chat.html?channel=chan-A'), true);
  check('Firestore Timestamp shape is accepted',
    viewing(surface({ lastActiveAt: { toMillis: () => FRESH } }), '/rm/pages/chat.html?channel=chan-A'), true);
  check('a pane path in paths[] counts (split-view)',
    viewing(surface({ paths: ['/rm/pages/split-view.html', '/rm/pages/chat.html'] }),
      '/rm/pages/chat.html?channel=chan-A'), true);
  check('a stale phone does not mask a fresh desktop',
    viewing({ surfaces: {
      phone: { paths: ['/rm/pages/chat.html'], contextIds: ['chan-A'], visible: true, lastActiveAt: STALE },
      desk:  { paths: ['/rm/pages/chat.html'], contextIds: ['chan-A'], visible: true, lastActiveAt: FRESH },
    } }, '/rm/pages/chat.html?channel=chan-A'), true);
}

/* ── FAIL OPEN: everything else must still notify ───────────── */
{
  // The two behaviours Alex asked for by name.
  check('on chat, message in ANOTHER channel', viewing(surface(), '/rm/pages/chat.html?channel=chan-B'), false);
  check('on chat, EQUIPMENT notification', viewing(surface(), '/rm/pages/equipment.html'), false);

  check('heartbeat gone stale (walked away)',
    viewing(surface({ lastActiveAt: STALE }), '/rm/pages/chat.html?channel=chan-A'), false);
  check('surface hidden', viewing(surface({ visible: false }), '/rm/pages/chat.html?channel=chan-A'), false);
  check('visible flag absent', viewing(surface({ visible: undefined }), '/rm/pages/chat.html?channel=chan-A'), false);
  check('scrolled into history (contextIds [])',
    viewing(surface({ contextIds: [] }), '/rm/pages/chat.html?channel=chan-A'), false);
  check('no presence doc at all', viewing(null, '/rm/pages/chat.html?channel=chan-A'), false);
  check('empty doc', viewing({}, '/rm/pages/chat.html?channel=chan-A'), false);
  check('surfaces is not an object', viewing({ surfaces: 'nope' }, '/rm/pages/chat.html?channel=chan-A'), false);
  check('null surface entry', viewing({ surfaces: { d: null } }, '/rm/pages/chat.html?channel=chan-A'), false);
  check('paths absent', viewing(surface({ paths: undefined }), '/rm/pages/chat.html?channel=chan-A'), false);
  check('lastActiveAt absent', viewing(surface({ lastActiveAt: null }), '/rm/pages/chat.html?channel=chan-A'), false);
  check('unparseable timestamp', viewing(surface({ lastActiveAt: 'not-a-date' }), '/rm/pages/chat.html?channel=chan-A'), false);
  check('client clock far in the future',
    viewing(surface({ lastActiveAt: NOW + 600 * 1000 }), '/rm/pages/chat.html?channel=chan-A'), false);
  check('notif carries no url', P.isViewing(surface(), P.surfaceKeyFromUrl(undefined), NOW), false);
  check('a different page entirely', viewing(surface(), '/rm/pages/tasks.html'), false);
}

/* ── filterByPresence (uses the real clock) ─────────────────── */
const fakeDb = {
  collection: () => ({ doc: (id) => ({ __id: id }) }),
  getAll: async (...refs) => refs.map((r) => ({
    exists: r.__id === 'u-watching',
    data: () => surface({ lastActiveAt: Date.now() - 10 * 1000 }),
  })),
};

(async () => {
  const r1 = await P.filterByPresence(fakeDb, ['u-watching', 'u-away'],
    { url: '/rm/pages/chat.html?channel=chan-A', title: 'msg' });
  check('watcher dropped, everyone else kept', r1, { send: ['u-away'], suppressed: ['u-watching'] });

  const r2 = await P.filterByPresence(fakeDb, ['u-watching'],
    { url: '/rm/pages/chat.html?channel=chan-A', urgent: true });
  check('urgent (ringing voice call) bypasses the gate', r2.send, ['u-watching']);

  const boomDb = { collection: fakeDb.collection, getAll: async () => { throw new Error('boom'); } };
  const r3 = await P.filterByPresence(boomDb, ['u-watching'], { url: '/rm/pages/chat.html?channel=chan-A' });
  check('a presence read failure fails OPEN', r3.send, ['u-watching']);

  /* ── report ───────────────────────────────────────────────── */
  console.log(`\npresence: ${pass} passed, ${fail} failed`);
  if (fail) {
    console.log('\nFailures:');
    failures.forEach((f) => console.log('  ✗ ' + f));
    process.exit(1);
  }
  console.log('All presence fixtures green.\n');
})();
