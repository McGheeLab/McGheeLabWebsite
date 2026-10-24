"""PSF table for the strategy explorer (pe-bead-strategy.html), from the repo's optics.py.

    python3 Research/bead_confocal_sim/interactive/tools/strategy/psf_table.py > …/tools/strategy/psf_table.json
    node …/tools/strategy/rim_table.js > …/tools/strategy/rim_table.json   (merged into psf_table.json as sub_rim)
    python3 …/tools/strategy/make_include.py    (writes src/strategy-psf-table.js for build.py)

Per objective (10x/0.45, 20x/0.75, 20x/0.80) and pinhole (0.5, 1, 2, 3, 4 AU), with R = 4 um and an
index-matched bead (no refraction):
  ih[z0]   = integral of H(z - z0) dz over the bead, z in [-R, R], for z0 = 0 … 6 um in 0.25 um steps (um^3)
  H0       = H(0), plane-integrated response in focus (um^2);  Veff = 2 * integral H dz (um^3);  leff = Veff / H0 (um)
  fz, fzs  = on-axis and plane-integrated (sea) axial FWHM (um);  fxy = lateral FWHM (um);  D00 = in-focus pinhole pass
  ph       = pinhole diameter at the sample (um); w0 = excitation waist (um)
  sub_sheet[k], sub_bead[k] = signal / linear for a two-level PE at peak excitation k0 = k (k0 = k_ex * tau),
            sheet = an in-focus flat sheet, bead = the whole shell at z0 = 0 (hat-box weighting over z),
            both with the pinhole's detection weighting; sub_vol = the free-buffer volume (|z| <= 14 um), for the no-wash
            background; sub_rim (added by rim_table.js from the confocal engine) = the shell's rim peak. The repo's own
            shortcut (optics.py) is 1 / (1 + k0) for every molecule.
"""
import sys, json, numpy as np
import os; sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..'))
from optics import ConfocalPSF, OBJ
from scipy.stats import ncx2

R = 4.0
Z0 = np.round(np.arange(0, 6.0001, 0.25), 3)
K0 = np.round(np.logspace(-3, np.log10(3), 49), 6)
out = {'z0': Z0.tolist(), 'k0': K0.tolist(), 'cfg': {}}
for key in ('10x', '20x', '20xD'):
    for AU in (0.5, 1, 2, 3, 4):
        p = ConfocalPSF(OBJ[key], AU)
        ih = []
        for z0 in Z0:
            z = np.linspace(-R, R, 4001)
            ih.append(float(np.trapezoid(p.Hz(z - z0), z)))
        # saturation: I(rho,z) * D(rho,z), with the emission of each molecule k I / (1 + k I)
        rg = p.rg; zz = np.arange(0, R + 1e-9, 0.05)
        I = (p.w0 / p.w(zz)[None, :]) ** 2 * np.exp(-2 * rg[:, None] ** 2 / p.w(zz)[None, :] ** 2)
        s = p.s_det(zz)[None, :]
        D = ncx2.cdf((p.a / s) ** 2, 2, np.maximum((rg[:, None] / s) ** 2, 1e-12))
        wr = 2 * np.pi * rg[:, None]
        lin_sheet = np.trapezoid(wr[:, 0] * I[:, 0] * D[:, 0], rg)
        lin_plane = np.trapezoid(wr * I * D, rg, axis=0)
        lin_bead = np.trapezoid(lin_plane, zz)
        # the free-buffer volume: |z| up to 14 um, all of it (no bead excluded) — for the no-wash background
        zv = np.arange(0, 14 + 1e-9, 0.05)
        Iv = (p.w0 / p.w(zv)[None, :]) ** 2 * np.exp(-2 * rg[:, None] ** 2 / p.w(zv)[None, :] ** 2)
        sv = p.s_det(zv)[None, :]
        Dv = ncx2.cdf((p.a / sv) ** 2, 2, np.maximum((rg[:, None] / sv) ** 2, 1e-12))
        lin_vol = np.trapezoid(np.trapezoid(wr * Iv * Dv, rg, axis=0), zv)
        ss, sb, svl = [], [], []
        for k in K0:
            ss.append(float(np.trapezoid(wr[:, 0] * I[:, 0] * D[:, 0] / (1 + k * I[:, 0]), rg) / lin_sheet))
            pl = np.trapezoid(wr * I * D / (1 + k * I), rg, axis=0)
            sb.append(float(np.trapezoid(pl, zz) / lin_bead))
            svl.append(float(np.trapezoid(np.trapezoid(wr * Iv * Dv / (1 + k * Iv), rg, axis=0), zv) / lin_vol))
        H0 = float(p.H[0])
        out['cfg'][f'{key}|{AU:g}'] = dict(ih=[round(v, 4) for v in ih], H0=round(H0, 5), Veff=round(float(p.Veff), 3), leff=round(float(p.Veff) / H0, 3),
                                          fz=round(float(p.fwhm_z_onaxis()), 2), fzs=round(float(p.fwhm_z_sea()), 2), fxy=round(float(p.fwhm_xy()), 3),
                                          D00=round(p.D00(), 4), ph=round(2 * p.a, 3), w0=round(p.w0, 4),
                                          sub_sheet=[round(v, 5) for v in ss], sub_bead=[round(v, 5) for v in sb], sub_vol=[round(v, 5) for v in svl])
        c = out['cfg'][f'{key}|{AU:g}']
        print(key, AU, 'ih0 %.3f  dF1 %.2f%%  dF2 %.2f%%  leff %.2f  fz %.2f fzs %.2f' % (ih[0], 100 * (ih[4] / ih[0] - 1), 100 * (ih[8] / ih[0] - 1), c['leff'], c['fz'], c['fzs']), file=sys.stderr)
json.dump(out, sys.stdout, separators=(',', ':'))
