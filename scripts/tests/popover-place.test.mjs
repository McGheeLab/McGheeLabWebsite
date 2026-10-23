/* popover-place.test.mjs — node scripts/tests/popover-place.test.mjs
 * Pins V3.827 POPOVER_PLACE.compute: below when it fits, above when below
 * does not, clamped to the top edge when neither does; never past an edge. */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const P = require('../../rm/js/popover-place.js');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  FAIL ' + m); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), m + ' → got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b));
const V = { w: 1000, h: 800 };
const A = (left, top) => ({ left, top, right: left + 60, bottom: top + 24 });
const inside = (r, w, h) => r.left >= 8 && r.top >= 8 && r.left + w <= V.w - 8 && r.top + Math.min(h, r.maxHeight) <= V.h - 8;

let r = P.compute({ w: 340, h: 300, anchor: A(100, 100), viewport: V });
eq([r.placement, r.left, r.top], ['below', 100, 130], 'room below → below the anchor, aligned to its left');
r = P.compute({ w: 340, h: 300, anchor: A(100, 100), viewport: V, preferLeft: -20 });
eq([r.left, r.placement], [8, 'below'], 'a preferred left past the edge is pulled in to the margin');
r = P.compute({ w: 340, h: 500, anchor: A(900, 700), viewport: V });
ok(r.placement === 'above' && r.top === 700 - 6 - 500 && r.left === 1000 - 340 - 8 && inside(r, 340, 500), 'near the bottom-right: above the anchor, pulled left: ' + JSON.stringify(r));
r = P.compute({ w: 340, h: 700, anchor: A(500, 400), viewport: V });
ok(r.placement === 'clamped' && r.top === 800 - 8 - 700 && inside(r, 340, 700), 'too tall for either side → as high as needed, still inside: ' + JSON.stringify(r));
r = P.compute({ w: 340, h: 1200, anchor: A(500, 400), viewport: V });
ok(r.placement === 'clamped' && r.top === 8 && r.maxHeight === 784, 'taller than the window → top margin, maxHeight = window − margins: ' + JSON.stringify(r));
r = P.compute({ w: 340, h: 300, anchor: A(100, 100), viewport: { w: 360, h: 600 } });
ok(r.width === 340 && r.left === 12, 'a 360-wide window still fits 340 — pulled to the right margin: ' + JSON.stringify(r));
r = P.compute({ w: 340, h: 300, anchor: A(100, 100), viewport: { w: 340, h: 600 } });
ok(r.width === 324 && r.left === 8, 'a narrower window shrinks the width to fit: ' + JSON.stringify(r));
r = P.compute({ w: 340, h: 300, anchor: A(100, 100), viewport: V, gap: 10, margin: 20 });
eq([r.top, r.left], [134, 100], 'gap and margin are honoured');
console.log(`popover-place: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
