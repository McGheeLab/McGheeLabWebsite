"""Collection factor c(z) of a PE emitter on the shell of an 8 um bead, relative to an index-matched bead
(geometric ray trace, report_calcs/ray.py), tabulated for the confocal simulator's "bead material" setting.

    python3 Research/bead_confocal_sim/interactive/tools/ray_table.py > Research/bead_confocal_sim/interactive/tools/ray_table.json

z is the emitter's height on the shell (um, + = away from the coverslip, the objective is below). c(z) = fraction of
isotropic emission that leaves the bead inside the objective's acceptance cone, divided by the same fraction with no
bead. Emission only; the page offers c(z)^2 as a reciprocity proxy for excitation x emission (report B.1.4, editor's
note). It ignores the apparent shift of the source and all wave effects: an estimate, not a measurement.
"""
import json, os, sys
import numpy as np
src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'report_calcs', 'ray.py')).read()
exec(src.split('for lab,sinth')[0].replace('app=np.linalg.solve(A,b)', 'app=np.zeros(3)'))
zs = np.round(np.linspace(-3.96, 3.96, 45), 3)
out = {'zs': zs.tolist(), 'R': 4.0, 'n_medium': 1.33, 'note': 'geometric ray trace, emission only; relative to an index-matched bead', 'c': {}}
for key, NA in (('10x', 0.45), ('20x', 0.75), ('20xD', 0.80)):
    sinth = NA / 1.33
    f0 = (1 - np.sqrt(1 - sinth ** 2)) / 2
    out['c'][key] = {}
    for name, n_in in (('silica', 1.45), ('pmma', 1.49), ('ps', 1.59)):
        c = [float(trace(z, n_in, sinth, N=250000)[0] / f0) for z in zs]
        out['c'][key][name] = [round(v, 4) for v in c]
        print(key, name, ' '.join('%.2f' % v for v in c[::4]), file=sys.stderr, flush=True)
print(json.dumps(out))
