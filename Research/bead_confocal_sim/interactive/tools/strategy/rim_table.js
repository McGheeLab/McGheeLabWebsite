/* Rim-peak sublinearity of a PE shell (R = 4 µm, z0 = 0) against k0, from the main thread's confocal engine:
   setSaturation(P, k0) puts h = I/(1 + k0·I)·D point by point; the rim peak is the maximum of the finely sampled
   radial profile (no pixel binning).   node rim_table.js > rim_table.json */
const E = require(__dirname + '/../../src/confocal-engine.js');
const K0 = JSON.parse(require('fs').readFileSync(__dirname + '/psf_table.json', 'utf8')).k0;
const rs = []; for (let r = 3.2; r <= 4.6001; r += 0.01) rs.push(+r.toFixed(3));
const out = {}; const t0 = Date.now();
for (const obj of ['10x', '20x', '20xD']) for (const AU of [0.5, 1, 2, 3, 4]) {
  const P = E.psf(obj, AU); E.setSaturation(P, 0);
  const lin = Math.max(...E.shellProfile(P, 4, 0, rs));
  const F0 = E.Fshell(P, 4, 0, null);
  const rim = [], F = [];
  for (const k of K0) { E.setSaturation(P, k); rim.push(+(Math.max(...E.shellProfile(P, 4, 0, rs)) / lin).toFixed(5)); F.push(+(E.Fshell(P, 4, 0, null) / F0).toFixed(5)); }
  E.setSaturation(P, 0);
  out[obj + '|' + AU] = { rim, F };
  process.stderr.write(obj + ' ' + AU + ' rim@k0≈0.1 ' + rim[K0.findIndex(k => k >= 0.1)] + '  ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s\n');
}
process.stdout.write(JSON.stringify(out));
