"""Check the simulator's JS engine (src/confocal-engine.js) against optics.py.

    python3 Research/bead_confocal_sim/interactive/tools/check_confocal.py

Compares PSF widths, the plane-integrated response H(z), Veff, the hat-box integrated intensity at several focal
offsets, and a noise-free rendered bead (integrated metric, ring radius, rim peak) for every objective and a range of
pinholes. Both sides run at 0.01 µW with tau = 2.7 ns, so saturation (modelled differently on purpose) plays no part.
"""
import json, os, subprocess, sys
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', '..'))
from optics import OBJ, ConfocalPSF, Fluorophore, ScanSettings, BeadState, render, integrated_analytic  # noqa: E402

FL = Fluorophore(tau_fl_s=2.7e-9)
cases = [(o, au) for o in ('10x', '20x', '20xD') for au in (0.5, 1, 2, 4)]
py = []
for o, au in cases:
    p = ConfocalPSF(OBJ[o], au)
    row = dict(obj=o, AU=au, xy=p.fwhm_xy(), zOnAxis=p.fwhm_z_onaxis(), zPlane=p.fwhm_z_sea(), D00=p.D00(), Veff=p.Veff,
               H=[float(p.Hz(z)) for z in (0, 1, 2, 4, 8)])
    scan = ScanSettings(objective=o, pinhole_AU=au, px_per_bead=20, laser_uW=0.01, dwell_us=2, gain=20, offset_DN=200, read_noise_DN=3)
    row['F'] = [float(integrated_analytic(BeadState(z0_um=z0), scan, fluo=FL)) for z0 in (0, 1, 2, 3.5)]
    if au in (1, 4):
        r = render(BeadState(sigma_PE_um2=1000, z0_um=0.0), scan, fluo=FL, noise=False, fov_px=48)
        row['render'] = dict(integratedPe=r['integrated'] / scan.gain, ringR=r['ring_r_um'], peakPe=r['peak'] / scan.gain, centrePe=r['centre_mean'] / scan.gain)
    py.append(row)

js_src = r"""
const C = require(process.argv[1]);
const cases = JSON.parse(process.argv[2]), out = [];
for (const [o, au] of cases) {
  const P = C.psf(o, au); C.setSaturation(P, 0); const w = C.widths(P);
  const row = { xy: w.xy, zOnAxis: w.zOnAxis, zPlane: w.zPlane, D00: w.D00, Veff: w.Veff, H: [0, 1, 2, 4, 8].map(z => C.Hat(P, z)) };
  const bead = { R: 4, sigma: 1000, z0: 0, offX: 0, offY: 0, kind: 'shell', material: 'matched' };
  const scan = { obj: o, AU: au, ppb: 20, dwell: 2, uW: 0.01, gain: 20, enf: 1.3, offset: 200, read: 3, bits: 16, transmission: 0.4, QE: 0.4, avg: 1, noise: false };
  row.F = [0, 1, 2, 3.5].map(z0 => { const r = C.render(Object.assign({}, bead, { z0, sigma: 1000 }), scan); return r.Fanalytic * 1; });
  if (au === 1 || au === 4) { const r = C.render(bead, scan); row.render = { integratedPe: r.m.integratedPe, ringR: r.m.ringR, peakPe: r.m.peakPe, centrePe: r.m.centre / scan.gain }; }
  out.push(row);
}
console.log(JSON.stringify(out));
"""
js = json.loads(subprocess.run(['node', '-e', js_src, os.path.join(HERE, '..', 'src', 'confocal-engine.js'), json.dumps(cases)], capture_output=True, text=True, check=True).stdout)
worst = {}
def cmp(key, a, b, tol):
    d = abs(a - b) / max(abs(b), 1e-12)
    worst[key] = max(worst.get(key, 0), d)
    return d <= tol
bad = 0
print('%-5s %4s | %-30s | %-30s | %s' % ('obj', 'AU', 'FWHM xy / z on-axis / z plane', 'Veff · H(0) · F(z0=0,1,2,3.5)', 'render: F · ring · peak'))
for p, j in zip(py, js):
    # the Python reads widths off a 0.05 um grid without interpolating, so allow one grid step there
    ok = all([abs(j['xy'] - p['xy']) <= 0.06, abs(j['zOnAxis'] - p['zOnAxis']) <= 0.11, abs(j['zPlane'] - p['zPlane']) <= 0.11,
              cmp('Veff', j['Veff'], p['Veff'], 0.01), cmp('H0', j['H'][0], p['H'][0], 0.01)] + [cmp('F', a, b, 0.01) for a, b in zip(j['F'], p['F'])])
    s = '%-5s %4.1f | %.2f/%.2f  %.2f/%.2f  %.2f/%.2f | %.3f/%.3f  F0 %.4g/%.4g F2 %.4g/%.4g' % (p['obj'], p['AU'], j['xy'], p['xy'], j['zOnAxis'], p['zOnAxis'], j['zPlane'], p['zPlane'], j['Veff'], p['Veff'], j['F'][0], p['F'][0], j['F'][2], p['F'][2])
    if 'render' in p:
        a, b = j['render'], p['render']
        ok &= cmp('render F', a['integratedPe'], b['integratedPe'], 0.02)
        s += ' | %.4g/%.4g  %.2f/%.2f  %.4g/%.4g' % (a['integratedPe'], b['integratedPe'], a['ringR'], b['ringR'], a['peakPe'], b['peakPe'])
    print(s + ('' if ok else '   <-- MISMATCH'))
    bad += not ok
print('worst relative differences:', {k: '%.2f%%' % (100 * v) for k, v in worst.items()})
sys.exit(1 if bad else 0)
