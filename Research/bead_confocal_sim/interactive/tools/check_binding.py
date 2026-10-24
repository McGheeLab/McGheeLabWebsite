"""Check the binding page's engine (the ENGINE block of src/pe-bead-binding.html, exactly what ships) against binding.py.

    python3 Research/bead_confocal_sim/interactive/tools/check_binding.py

Seven cases (tools/binding_cases.json: the report's reference, binding.py's first-pass defaults, D_T 100 nM, transport
off, 1e5 beads, a 24 h incubation, dependent epitopes); for each, PE per bead at the end of the incubation and at
imaging for nine analyte levels from 1 fM to 10 uM, and the post-wash decay after a 1 pM incubation. Pass: every value
within 0.5 % (values under 1e-3 PE per bead are skipped).
"""
import json, os, re, subprocess, sys, tempfile
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', '..'))
from binding import BeadAssay  # noqa: E402

cases = json.load(open(os.path.join(HERE, 'binding_cases.json')))
AS = [1e-15, 1e-12, 1e-10, 1e-9, 3e-9, 1e-8, 1e-7, 1e-6, 1e-5]
WT = [60, 300, 900, 3600, 7200]

py = {}
for name, c in cases.items():
    kw = dict(k1=c['k1'], km1=c['km1'], k2=c['k2'], km2=c['km2'], S_T=c['NS'], R_um=c['R_um'], n_beads=c['nb'], V_uL=c['V_uL'],
              D_A=c['DA'] * 1e-4, D_D=c['DD'] * 1e-4, D_AD=c.get('DAD', c['DD']) * 1e-4, transport=c['transport'])
    if not c.get('independent', True):
        kw.update(k3=c['k3'], km3=c['km3'], k4=c['k4'], km4=c['km4'])
    a = BeadAssay(**kw)
    r = {'inc': [float(a.endpoint(A, c['DT'], c['tInc'], 0.0)[0]) for A in AS],
         'img': [float(a.endpoint(A, c['DT'], c['tInc'], c['tw'])[0]) for A in AS]}
    _, y = a.endpoint(1e-12, c['DT'], c['tInc'], 0.0)
    r['wash'] = [float(v) for v in a.wash(y, max(WT), t_eval=WT).y[4]]
    py[name] = r

page = open(os.path.join(HERE, '..', 'src', 'pe-bead-binding.html')).read()
engine = re.search(r'/\*ENGINE-START\*/(.*?)/\*ENGINE-END\*/', page, re.S).group(1)
js = engine + r"""
const cases = JSON.parse(process.argv[2]), AS = JSON.parse(process.argv[3]), WT = JSON.parse(process.argv[4]), out = {};
for (const [name, c] of Object.entries(cases)) {
  const m = ENGINE.model(Object.assign({}, c, { DAD: c.DAD || c.DD }));
  const r = { inc: AS.map(A => m.endpoint(A, c.DT, c.tInc, 0, { rtol: 1e-7 }).sad), img: AS.map(A => m.endpoint(A, c.DT, c.tInc, c.tw, { rtol: 1e-7 }).sad) };
  const y = m.incubate(1e-12, c.DT, c.tInc, { rtol: 1e-7 }).y;
  r.wash = WT.map(t => m.wash(y, t, 1e-12, c.DT, { rtol: 1e-7 }).y[4]);
  out[name] = r;
}
console.log(JSON.stringify(out));
"""
with tempfile.NamedTemporaryFile('w', suffix='.js', delete=False) as f:
    f.write(js)
jo = json.loads(subprocess.run(['node', f.name, json.dumps(cases), json.dumps(AS), json.dumps(WT)], capture_output=True, text=True, check=True).stdout)
bad = 0
print('%-26s %12s %12s %12s' % ('case', 'incubation', 'at imaging', 'wash decay'))
for name in cases:
    worst = []
    for key in ('inc', 'img', 'wash'):
        d = [abs(a - b) / abs(b) for a, b in zip(jo[name][key], py[name][key]) if abs(b) > 1e-3]
        worst.append(max(d) if d else 0.0)
    ok = all(w <= 0.005 for w in worst)
    bad += not ok
    print('%-26s %11.4f%% %11.4f%% %11.4f%%%s' % (name, 100 * worst[0], 100 * worst[1], 100 * worst[2], '' if ok else '   <-- MISMATCH'))
sys.exit(1 if bad else 0)
