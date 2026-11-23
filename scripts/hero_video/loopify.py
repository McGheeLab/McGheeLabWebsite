#!/usr/bin/env python3
"""
loopify.py — turn the simulation record (simulate.py) into a seamless loop, and
work out how much each granule is squashed.

1. The seam. The bath, the feed schedule and every random stream are periodic
   with the loop length, so frame T is frame 0 shifted by one period L — except
   that yielding is chaotic: the *arrangement* of the wake repeats closely, but
   which granule ends up where does not. So the seam is closed on the
   arrangement: at the last frame every granule and cell is matched to the
   nearest unclaimed one of the same kind in the loop-start arrangement
   (shifted by L), and over the last M frames it glides onto that partner's
   track (a morph of the data, not a crossfade of the pictures). Unmatched ones
   shrink away; partners nothing matched grow in from spare slots.
   Protrusions hand over the same way.

2. The squash. The simulation's granules are soft spheres whose overlaps stand
   for flattened contacts. For each granule in view, every contact (with
   another granule or with the needle) flattens it along the contact normal by
   its share of the overlap; the result is made volume-preserving (hydrogel
   granules are nearly incompressible), so a granule pressed against the needle
   flattens there and bulges sideways. Stored as `gdef` = B − I (6 components,
   xx yy zz xy xz yz), B being the symmetric shape tensor the renderer applies.

The output holds exactly loop_frames frames in loop order, plus `gscale`
(per-frame size factor, 1 except at the seam).

Run:  python3 scripts/hero_video/loopify.py <sim.npz> <loop.npz> [M]
"""
import sys, json
import numpy as np
from scipy.spatial import cKDTree

src, dst = sys.argv[1], sys.argv[2]
M = int(sys.argv[3]) if len(sys.argv) > 3 else 72
MATCH_R = 3.5            # a granule may glide at most this far to meet its partner
VIEW_X = 40.0            # half-width (sim units) of the region around the needle that is matched and squashed
d = np.load(src); meta = json.loads(str(d['meta'])); P = meta['P']
EX, F, Nb, L = meta['extra'], meta['loop_frames'], meta['Nb'], meta['L']
assert EX >= M, f'need extra_frames >= {M}'
Xmax = meta.get('Xmax', int(P['tiles'])*L)
gpos, cpos, cu, csp, cbr, ptar, pgrow, needle = (d[k] for k in ('gpos','cpos','cu','cspread','cbr','ptar','pgrow','needle'))
rad, typ = d['rad'], d['typ']
N = gpos.shape[1]; C = cpos.shape[1]
rE, rP = F - 1 + EX, EX - 1                       # last frame of the loop, and the frame just before the loop start
SHIFT = np.array([L, 0, 0])
def wrapx(v):
    v = v.copy(); v[..., 0] -= Xmax*np.round(v[..., 0]/Xmax); return v

# ── match granules at the seam: own (last frame) ↔ partner (loop start, shifted by L), by kind ──
xn = needle[rE, 0]
own_act = gpos[rE][:, 2] > -10
par_act = gpos[rP][:, 2] > -10
par_pos = gpos[rP].astype(np.float64) + SHIFT
par_pos[:, 0] = np.mod(par_pos[:, 0], Xmax)
in_view = lambda p: (np.abs(wrapx(p - [xn, 0, 0])[:, 0]) < VIEW_X + 10)
g_match = np.full(N, -1)                           # own index → partner index
claimed = np.zeros(N, bool)
for kind in (0, 1):
    A = np.nonzero(own_act & (typ == kind) & in_view(gpos[rE]))[0]
    B = np.nonzero(par_act & (typ == kind) & in_view(par_pos))[0]
    if len(A) == 0 or len(B) == 0: continue
    pairs = cKDTree(par_pos[B]).query_ball_point(gpos[rE][A], MATCH_R)
    cand = sorted((np.linalg.norm(wrapx(par_pos[B[j]] - gpos[rE][a])), a, B[j]) for a, js in zip(A, pairs) for j in js)
    for dist, a, b in cand:
        if g_match[a] < 0 and not claimed[b]:
            g_match[a] = b; claimed[b] = True
    print(f'kind {kind}: {len(A)} own, {len(B)} partner, matched {(g_match[A] >= 0).sum()}; '
          f'unmatched own {(g_match[A] < 0).sum()}, unmatched partner {(~claimed[B]).sum()}')
own_unmatched = np.nonzero(own_act & in_view(gpos[rE]) & (g_match < 0))[0]
par_unmatched = np.nonzero(par_act & in_view(par_pos) & ~claimed)[0]
N_spare = len(par_unmatched); N2 = N + N_spare
partner_to_own = np.full(N, -1); partner_to_own[g_match[g_match >= 0]] = np.nonzero(g_match >= 0)[0]
partner_to_own[par_unmatched] = N + np.arange(N_spare)

# ── cells: the same matching ──
c_own = np.nonzero(cpos[rE][:, 2] > -10)[0]
c_par_pos = cpos[rP].astype(np.float64) + SHIFT; c_par_pos[:, 0] = np.mod(c_par_pos[:, 0], Xmax)
c_par = np.nonzero(cpos[rP][:, 2] > -10)[0]
c_match = np.full(C, -1); c_claimed = np.zeros(C, bool)
cand = sorted((np.linalg.norm(wrapx(c_par_pos[b] - cpos[rE][a])), a, b) for a in c_own for b in c_par)
for dist, a, b in cand:
    if dist > 6.0: break
    if c_match[a] < 0 and not c_claimed[b]:
        c_match[a] = b; c_claimed[b] = True
c_own_un = c_own[c_match[c_own] < 0]; c_par_un = c_par[~c_claimed[c_par]]
C_spare = len(c_par_un); C2 = C + C_spare
c_partner_to_own = np.full(C, -1); c_partner_to_own[c_match[c_match >= 0]] = np.nonzero(c_match >= 0)[0]
c_partner_to_own[c_par_un] = C + np.arange(C_spare)
print(f'cells: {len(c_own)} own, {len(c_par)} partner, matched {(c_match >= 0).sum()}, spare {C_spare}')

out = dict(gpos=np.zeros((F, N2, 3), np.float32), gscale=np.ones((F, N2), np.float32), gdef=np.zeros((F, N2, 6), np.float16),
           cpos=np.zeros((F, C2, 3), np.float32), cu=np.zeros((F, C2, 3), np.float32), cscale=np.ones((F, C2), np.float32),
           cspread=np.zeros((F, C2), np.float32), cbr=np.zeros((F, C2, 3), np.float32),
           ptar=np.full((F, C2, 4), -1, np.int32), pgrow=np.zeros((F, C2, 4), np.float32), needle=np.zeros((F, 3), np.float32),
           chost=np.full((F, C2), -1, np.int32))
out['gpos'][:, :, 2] = -60; out['cpos'][:, :, 2] = -60
rad2 = np.concatenate([rad, rad[par_unmatched]]).astype(np.float32); typ2 = np.concatenate([typ, typ[par_unmatched]])
shifts = []
for f in range(F):
    r = f + EX
    out['needle'][f] = needle[r]
    out['gpos'][f, :N] = gpos[r]; out['cpos'][f, :C] = cpos[r]; out['cu'][f, :C] = cu[r]; out['cspread'][f, :C] = csp[r]; out['cbr'][f, :C] = cbr[r]
    out['ptar'][f, :C, :2] = ptar[r]; out['pgrow'][f, :C, :2] = pgrow[r]
    if 'chost' in d: out['chost'][f, :C] = d['chost'][r]
    if f < F - M: continue
    w = (f - (F - M) + 1)/(M + 1)
    w = w*w*(3 - 2*w)                                 # ease in and out, so no granule starts or stops gliding abruptly
    rp = f - F + EX                                   # the partner's frame, before the loop start
    pp = gpos[rp].astype(np.float64) + SHIFT; pp[:, 0] = np.mod(pp[:, 0], Xmax)
    a = np.nonzero(g_match >= 0)[0]; b = g_match[a]
    dlt = wrapx(pp[b] - gpos[r][a].astype(np.float64))
    live = (gpos[r][a][:, 2] > -10) & (gpos[rp][b][:, 2] > -10)
    out['gpos'][f, a[live]] = gpos[r][a[live]] + w*dlt[live]
    if f == F - 1: shifts = np.linalg.norm(dlt[live], axis=1)
    out['gscale'][f, own_unmatched] = 1 - w
    out['gpos'][f, N:] = pp[par_unmatched]; out['gscale'][f, N:] = w
    a = np.nonzero(c_match >= 0)[0]; b = c_match[a]
    cpp = cpos[rp].astype(np.float64) + SHIFT; cpp[:, 0] = np.mod(cpp[:, 0], Xmax)
    live = (cpos[r][a][:, 2] > -10) & (cpos[rp][b][:, 2] > -10)
    a, b = a[live], b[live]
    out['cpos'][f, a] = cpos[r][a] + w*wrapx(cpp[b] - cpos[r][a].astype(np.float64))
    ub = (1 - w)*cu[r][a] + w*cu[rp][b]; out['cu'][f, a] = ub/(np.linalg.norm(ub, axis=1)[:, None] + 1e-9)
    out['cspread'][f, a] = (1 - w)*csp[r][a] + w*csp[rp][b]
    out['cbr'][f, a] = (1 - w)*cbr[r][a] + w*cbr[rp][b]
    out['cscale'][f, c_own_un] = 1 - w
    out['cpos'][f, C:] = cpp[c_par_un]; out['cu'][f, C:] = cu[rp][c_par_un]; out['cspread'][f, C:] = csp[rp][c_par_un]
    out['cbr'][f, C:] = cbr[rp][c_par_un]; out['cscale'][f, C:] = w
    out['pgrow'][f, :C, :2] = pgrow[r]*(1 - w)
    for b_ in c_par:
        o = c_partner_to_own[b_]
        if o < 0 or cpos[rp][b_][2] < -10: continue
        for s_ in range(2):
            jt = ptar[rp, b_, s_]
            if jt >= 0 and pgrow[rp, b_, s_] > 0 and partner_to_own[jt] >= 0:
                out['ptar'][f, o, 2 + s_] = partner_to_own[jt]; out['pgrow'][f, o, 2 + s_] = pgrow[rp, b_, s_]*w
print(f'seam: {N2} granule slots ({N_spare} spare), {C2} cell slots; glide median {np.median(shifts):.3f}, '
      f'90% {np.percentile(shifts, 90):.3f}, max {shifts.max():.3f} units')

# ── the squash: a volume-preserving shape tensor per granule from its contacts ──
Rn, Ri, ztip = P['Rn'], P['Ri'], P['ztip']
eye = np.eye(3)
flat_stats = []
for f in range(F):
    p = out['gpos'][f].astype(np.float64); r_ = rad2*out['gscale'][f]
    xc = out['needle'][f, 0]
    rel = wrapx(p - [xc, 0, 0])
    sel = np.nonzero((p[:, 2] > -10) & (np.abs(rel[:, 0]) < VIEW_X) & (rel[:, 1] > -6) & (rel[:, 1] < 18) & (r_ > 0.05))[0]
    q = rel[sel]; rs = r_[sel]
    S = np.zeros((len(sel), 3, 3))
    pairs = cKDTree(q).query_pairs(2*rad2.max(), output_type='ndarray')
    if len(pairs):
        i, j = pairs[:, 0], pairs[:, 1]
        dv = q[j] - q[i]; dist = np.linalg.norm(dv, axis=1) + 1e-9
        ov = rs[i] + rs[j] - dist; m = ov > 0
        i, j, n, ov = i[m], j[m], dv[m]/dist[m][:, None], ov[m]
        nn = n[:, :, None]*n[:, None, :]
        np.add.at(S, i, (ov/(2*rs[i]))[:, None, None]*nn)
        np.add.at(S, j, (ov/(2*rs[j]))[:, None, None]*nn)
    # the needle (rigid: the granule takes the whole overlap); ink inside the bore is hidden, skip it
    yn = out['needle'][f, 1]
    rx, ry = q[:, 0], q[:, 1] - yn
    radial = np.hypot(rx, ry) + 1e-9; ex, ey = rx/radial, ry/radial
    above = q[:, 2] >= ztip
    r_in = np.where(typ2[sel] == 1, Ri, 0.0)
    cr = np.where(above, Rn, np.clip(radial, r_in, Rn))
    dxr = radial - cr; dzz = np.where(above, 0.0, q[:, 2] - ztip)
    dist = np.hypot(dxr, dzz) + 1e-9
    ov = rs - dist
    m = (ov > 0) & ~(above & (radial < Rn))
    n = np.column_stack([dxr/dist*ex, dxr/dist*ey, dzz/dist])
    S[m] += (ov[m]/rs[m])[:, None, None]*(n[m][:, :, None]*n[m][:, None, :])
    B = eye - S
    wv, V = np.linalg.eigh(B)
    wv = np.clip(wv, 0.55, 1.25)
    wv /= np.cbrt(np.prod(wv, axis=1))[:, None]
    B = np.einsum('nij,nj,nkj->nik', V, wv, V)
    D = B - eye
    out['gdef'][f, sel] = np.column_stack([D[:, 0, 0], D[:, 1, 1], D[:, 2, 2], D[:, 0, 1], D[:, 0, 2], D[:, 1, 2]]).astype(np.float16)
    flat_stats.append(1 - wv.min(axis=1))
fs = np.concatenate(flat_stats)
print(f'squash: smallest axis shortened by median {100*np.median(fs):.1f}%, 90% {100*np.percentile(fs, 90):.1f}%, max {100*fs.max():.1f}%')

meta2 = dict(meta); meta2.update(loop_frames=F, extra=0, morph_frames=M, Ntot=N2, C=C2)
np.savez_compressed(dst, rad=rad2, typ=typ2, meta=json.dumps(meta2), **out)
print(f'wrote {dst}: {F} frames')
