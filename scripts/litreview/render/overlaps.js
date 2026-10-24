// Boxes that overlap in a measured render. node overlaps.js boxes.json [pad] [records.json]
//   boxes.json = {blockId: [x, y, w, h]} written by view.mjs (BOXES=…); pad = the clear gap wanted between boxes
const path = require('path');
const b = require(path.resolve(process.argv[2])), pad = +(process.argv[3] || 0);
let lab = {}; try { const r = require(path.resolve(process.argv[4] || 'records.json')); lab = Object.fromEntries(r.ops.filter(o => o.store === 'blocks').map(o => [o.id, (o.rec.label || '').slice(0, 40)])); } catch (e) { /* labels are optional */ }
const E = Object.entries(b); let n = 0;
for (let i = 0; i < E.length; i++) for (let j = i + 1; j < E.length; j++) {
  const [a, A] = E[i], [c, B] = E[j];
  if (A[0] < B[0] + B[2] + pad && B[0] < A[0] + A[2] + pad && A[1] < B[1] + B[3] + pad && B[1] < A[1] + A[3] + pad) { n++; if (n < 15) console.log('overlap', lab[a] || a, '×', lab[c] || c); }
}
console.log('overlapping pairs:', n, '(pad ' + pad + ')');
