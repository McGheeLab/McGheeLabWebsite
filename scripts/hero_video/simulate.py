#!/usr/bin/env python3
"""
simulate.py — a needle writing cell-laden granular ink into a jammed microgel
bath (a liquid-like solid); the printed cells then crawl over the granules and
pull them together. Produces the frame data that loopify.py closes into a loop
and render_blender.py draws.

Physics (units: mean granule radius = 1, seconds). Everything the bath does is
emergent; nothing is scripted:
  * The bath is Durian's bubble model in 3D — the standard model for foams,
    emulsions and soft microgel packs: overdamped soft spheres with Hookean
    contacts, each dragged against the solvent at rest (velocity = F/γ). It is
    packed above jamming (φ = 0.72) and relaxed to mechanical equilibrium with
    FIRE, so it is a solid with a yield stress and a confining pressure; it
    yields beside the needle, flows round it and re-jams behind it purely from
    contact forces. (McGhee 2018, Exp Mech 58:137, for what that should look
    like: fluid-like beside the needle, solid-like ahead and behind,
    displacement about one needle diameter.)
  * The container is no-slip: the granules touching the floor and the side
    walls are fixed (rough walls), as a bath in a dish is held by its dish, so
    the needle cannot drag the whole bath along; the lid far above the frame
    is smooth.
  * The needle is a rigid, hollow, blunt cannula (outer radius Rn, bore radius
    Ri) moving at constant speed. Bath granules see it as a solid flat-tipped
    cylinder.
  * Extrusion is physical too: ink granules are fed into the bore, a piston
    force pushes the column down, the inner wall confines it, and the ink
    leaves through the bore's mouth, pushing bath granules aside to make room.
    The feed rate (K per period) sets the flow Q; the line's cross-section,
    its position relative to the tip and how much of the shaft's crevasse it
    fills all come out of the contacts (A = Q/v on average).
  * Cells are agents on top of the physics, following the GELLS-DEM life cycle
    on a clock compressed from days to seconds: suspended in the ink → attach
    to a granule surface → spread → crawl (persistent random walk on the
    surface) → reach across a void to a neighbouring granule → contract with a
    capped force, which really pulls the two granules together through the
    same contact mechanics. Cells live on granule surfaces and in the voids,
    never inside granules (GELS).

Looping: the bath is a strip of identical tiles, periodic along the print
direction with period L = v·T; the feed schedule and every random stream are
periodic with the same period; the camera (in Blender) tracks the needle. In
the needle's frame the process is steady, so frame T repeats frame 0 up to the
chaotic rearrangements in the wake, which loopify.py closes.

Run:  python3 scripts/hero_video/simulate.py <out.npz> [--quick]
"""
import sys, time, json
import numpy as np
from scipy.spatial import cKDTree

# ─────────────────────────── parameters ───────────────────────────
P = dict(
    fps=30, T=16.0, sub=8,          # loop seconds, substeps per frame
    v=3.0,                          # needle speed (units/s); L = v*T = 48
    tiles=5,                        # bath strip length in periods (the strip is periodic in x)
    Y=15.0, H=20.0,                 # half width, bed depth (smooth rigid lid; the free surface is far above the frame)
    wall_layer=1.5,                 # granules centred this close to the floor or a side wall are fixed: a no-slip container
    phi=0.72,                       # packing fraction: above jamming, so the pack is a compressed, yielding solid
    rmin=0.78, rmax=1.22,           # bath granule radii
    ink_rmin=0.68, ink_rmax=1.02,   # ink granule radii
    Rn=3.5, Ri=2.45, ztip=11.0,     # needle outer radius, bore radius, height of the blunt tip above the floor
    preroll_s=30.0,                 # seconds of printing before the loop starts (the wake must be steady in the needle's frame)
    k=1.0, kinv_gamma=48.0,         # contact stiffness, k/γ (1/s)
    k_needle=3.0,                   # needle contact stiffness (×k)
    K=450,                          # ink granules fed per period (≈ a line of the needle's cross-section: π·Rn²·L·0.65 / granule volume)
    f_piston=0.35,                  # extrusion: downward force on every particle in the bore (column pressure grows with its height)
    cell_every=5,                   # one cell per this many ink granules
    r_cell=0.33,                    # cell radius (a 16 µm cell on 50 µm granules)
    cell_gamma=0.4,                 # suspended cells move more easily than granules
    tau_att=(0.6, 1.2),             # s suspended before attaching
    spread_s=1.0,                   # s to spread once attached
    tau_br=(1.4, 2.8),              # s after attaching before reaching for a neighbour
    grow_s=0.8,                     # s for a protrusion to reach its target
    Fc=0.35, k_cell=0.8, tau_c=2.0, # contraction: a spring whose rest gap shrinks to zero over tau_c, capped at Fc (units of k·radius)
    reach=2.4, gap_min=0.45,        # a cell bridges a void between these surface gaps
    extra_frames=72,                # frames recorded before/after the loop (loopify.py morphs the seam over these)
    seed=7,
)

def rng_for(*ints):
    """A reproducible generator keyed on integers (periodic ids, phases)."""
    return np.random.default_rng(np.array(ints, dtype=np.int64))

def wall_forces(pos, r, Y, H, k):
    F = np.zeros_like(pos)
    F[:,2] += k*np.maximum(r - pos[:,2], 0)            # floor
    F[:,2] -= k*np.maximum(pos[:,2] + r - H, 0)        # lid
    F[:,1] += k*np.maximum(r - (pos[:,1] + Y), 0)      # side walls
    F[:,1] -= k*np.maximum(pos[:,1] + r - Y, 0)
    return F

def contact_forces(pos, r, pairs, Lx, k):
    i, j = pairs[:,0], pairs[:,1]
    F = np.zeros_like(pos)
    if len(i) == 0: return F
    d = pos[j] - pos[i]
    d[:,0] -= Lx*np.round(d[:,0]/Lx)
    dist = np.linalg.norm(d, axis=1) + 1e-9
    ov = r[i] + r[j] - dist
    m = ov > 0
    f = (k*ov[m]/dist[m])[:,None]*d[m]
    n = len(pos)
    for c in range(3):
        F[:,c] += np.bincount(j[m], weights=f[:,c], minlength=n) - np.bincount(i[m], weights=f[:,c], minlength=n)
    return F

# ─────────────────────────── bath packing ───────────────────────────
def pack_tile(P, L):
    """A jammed tile of polydisperse soft spheres, periodic in x: grow the spheres, then relax to
    mechanical equilibrium with FIRE (Bitzek et al. 2006) so the bath does not creep during the run."""
    rng = np.random.default_rng(P['seed'])
    Y, H, k = P['Y'], P['H'], P['k']
    r3 = (P['rmax']**4 - P['rmin']**4)/(4*(P['rmax'] - P['rmin']))     # E[r^3], uniform radii
    N = int(P['phi']*L*2*Y*H/(4/3*np.pi*r3))
    r_final = rng.uniform(P['rmin'], P['rmax'], N)
    pos = np.column_stack([rng.uniform(0, L, N), rng.uniform(-Y + 1, Y - 1, N), rng.uniform(1, H - 1, N)])
    BIG = 1e6
    def forces(pos, r):
        q = np.column_stack([np.mod(pos[:,0], L), pos[:,1] + BIG/2, pos[:,2] + BIG/2])
        pairs = cKDTree(q, boxsize=[L, BIG, BIG]).query_pairs(2*r.max(), output_type='ndarray')
        return contact_forces(pos, r, pairs, L, k) + wall_forces(pos, r, Y, H, k)
    for it in range(500):                                            # grow
        r = r_final*min(1.0, 0.55 + 0.45*it/400)
        pos += np.clip(0.2*forces(pos, r), -0.2, 0.2); pos[:,0] = np.mod(pos[:,0], L)
    v = np.zeros_like(pos); dtf, alpha, npos = 0.05, 0.1, 0         # FIRE
    for it in range(6000):
        F = forces(pos, r_final)
        fmax = np.abs(F).max()
        if fmax < 2e-5: break
        if (F*v).sum() > 0:
            npos += 1
            v = (1 - alpha)*v + alpha*np.linalg.norm(v)*F/(np.linalg.norm(F) + 1e-12)
            if npos > 5: dtf = min(dtf*1.1, 0.25); alpha *= 0.99
        else:
            npos = 0; v[:] = 0; dtf *= 0.5; alpha = 0.1
        v += F*dtf
        pos += np.clip(v*dtf, -0.1, 0.1); pos[:,0] = np.mod(pos[:,0], L)
    print(f'  packed {N} granules, φ={P["phi"]}, FIRE {it} iterations, max |F| {fmax:.1e}', flush=True)
    return pos, r_final

# ─────────────────────────── the needle ───────────────────────────
def needle_forces(ap, ar, inklike, xn, yn, P):
    """Forces from the rigid cannula. Bath granules see a solid flat-tipped cylinder (the bore is full of
    ink); ink granules and suspended cells see the hollow tube: confined by the inner wall inside the bore,
    pushed down by the piston, free to leave through the bore's mouth."""
    Rn, Ri, ztip, kn = P['Rn'], P['Ri'], P['ztip'], P['k_needle']*P['k']
    rx, ry = ap[:,0] - xn, ap[:,1] - yn
    rad_ = np.hypot(rx, ry) + 1e-9; ex, ey = rx/rad_, ry/rad_
    z = ap[:,2]
    F = np.zeros_like(ap)
    above = z >= ztip
    inbore = inklike & (rad_ < 0.5*(Ri + Rn))
    # above the tip, outside the tube: push radially out (also rescues a centre that strayed inside)
    m = above & ~inbore
    ov = ar[m] + Rn - rad_[m]; ok = ov > 0
    idx = np.nonzero(m)[0][ok]
    F[idx,0] += kn*ov[ok]*ex[idx]; F[idx,1] += kn*ov[ok]*ey[idx]
    # above the tip, inside the bore: the inner wall pushes in; the piston pushes down
    m = above & inbore
    ov = ar[m] - (Ri - rad_[m]); ok = ov > 0
    idx = np.nonzero(m)[0][ok]
    F[idx,0] -= kn*ov[ok]*ex[idx]; F[idx,1] -= kn*ov[ok]*ey[idx]
    F[m & (rad_ < Ri), 2] -= P['f_piston']
    # below the tip: distance to the nearest point of the tube's end (solid disc for the bath, annulus for ink)
    m = ~above
    r_in = np.where(inklike, Ri, 0.0)
    cr = np.clip(rad_, r_in, Rn)                                    # nearest point's radius on the end face
    dxr = rad_ - cr; dzz = z - ztip                                 # (dzz < 0)
    dist = np.hypot(dxr, dzz) + 1e-9
    ov = ar - dist; ok = m & (ov > 0)
    nr, nz = dxr/dist, dzz/dist
    F[ok,0] += kn*ov[ok]*nr[ok]*ex[ok]; F[ok,1] += kn*ov[ok]*nr[ok]*ey[ok]; F[ok,2] += kn*ov[ok]*nz[ok]
    return F

# ─────────────────────────── main run ───────────────────────────
def run(P, out, quick=False):
    t0 = time.time()
    fps, sub, T, v = P['fps'], P['sub'], P['T'], P['v']
    dt = 1/(fps*sub)
    L = v*T
    S_period = int(round(T*fps*sub))
    Y, H, Rn, Ri, ztip = P['Y'], P['H'], P['Rn'], P['Ri'], P['ztip']
    k, kg, K = P['k'], P['kinv_gamma'], P['K']

    print(f'packing one tile (L={L:.1f}) …', flush=True)
    tpos, tr = pack_tile(P, L)
    Nt = len(tpos); n_tiles = int(P['tiles'])
    gpos = np.vstack([tpos + [t*L, 0, 0] for t in range(n_tiles)]); gr = np.tile(tr, n_tiles)
    Nb = len(gpos)
    Xmax = n_tiles*L                       # the strip wraps: x is periodic with period Xmax
    BIG = 1e6
    def wrap(q):
        return np.column_stack([np.mod(q[:,0], Xmax), q[:,1] + BIG/2, q[:,2] + BIG/2])
    print(f'bath: {Nb} granules ({int(((gpos[:,2] < P["wall_layer"]) | (np.abs(gpos[:,1]) > Y - P["wall_layer"])).sum())} fixed at the walls), '
          f'strip {Xmax:.0f} × {2*Y:.0f} × {H:.1f}  ({time.time()-t0:.0f}s)', flush=True)

    # schedule ---------------------------------------------------------------
    pre_steps = int(round(P['preroll_s']*fps*sub))
    loop_frames = int(round(T*fps))
    EX = P['extra_frames']
    x_start = 9.0
    x0 = x_start + P['preroll_s']*v           # needle x at the loop start
    assert x0 + L + 0.45*L < Xmax, 'strip too short'
    n_steps = pre_steps + S_period + EX*sub + 1
    if quick: n_steps = pre_steps//3

    # particles --------------------------------------------------------------
    n_periods = (n_steps*dt*v)/L + 1
    Nink_max = int(K*n_periods) + 50
    C = int(K*n_periods/P['cell_every']) + 50
    Ntot = Nb + Nink_max
    pos = np.full((Ntot, 3), [0, 0, -60.0]); pos[:Nb] = gpos
    rad = np.zeros(Ntot); rad[:Nb] = gr
    typ = np.zeros(Ntot, dtype=np.int8); typ[Nb:] = 1            # 0 bath, 1 ink
    active = np.zeros(Ntot, bool); active[:Nb] = True
    fixed = np.zeros(Ntot, bool)
    fixed[:Nb] = (gpos[:,2] < P['wall_layer']) | (np.abs(gpos[:,1]) > Y - P['wall_layer'])
    n_ink = 0
    cpos = np.full((C, 3), [0, 0, -60.0]); cact = np.zeros(C, bool)
    cstate = np.zeros(C, np.int8)        # 0 suspended, 1 attached/spreading, 2 migrating, 3 bridging
    chost = np.full(C, -1); cu = np.zeros((C, 3)); ctv = np.zeros((C, 3))
    ct_born = np.zeros(C); ct_att = np.zeros(C); c_tau_att = np.zeros(C); c_tau_br = np.zeros(C)
    cspeed = np.zeros(C)
    ctar = np.full((C, 2), -1); cgrow = np.zeros((C, 2)); cpid = np.zeros(C, np.int64)
    cgap0 = np.zeros((C, 2)); ctg = np.full((C, 2), -1.0)   # gap when a protrusion finished growing, and when
    n_cell = 0
    rc = P['r_cell']
    feed_x = x_start + (np.arange(int(K*n_periods) + 5) + 0.5)*(L/K)   # needle x at which ink granule k is fed
    next_feed = 0

    # The needle starts inside the bath. Take out the granules it would occupy (volume matched), as if it
    # had been pushed in and the bath had relaxed, rather than exploding them out at t = 0.
    cand = np.nonzero(active[:Nb] & (pos[:Nb,2] > ztip - 0.8))[0]
    order = cand[np.argsort(np.hypot(pos[cand,0] - x_start, pos[cand,1]))]
    cum = np.cumsum(4/3*np.pi*rad[order]**3)
    n_rm = int(np.searchsorted(cum, P['phi']*np.pi*Rn**2*(H - ztip + 0.3)))
    active[order[:n_rm]] = False; pos[order[:n_rm]] = [0, 0, -60.0]

    # recording --------------------------------------------------------------
    rec_from = pre_steps - EX*sub
    n_rec = loop_frames + 2*EX
    R = dict(gpos=np.zeros((n_rec, Ntot, 3), np.float32),
             cpos=np.zeros((n_rec, C, 3), np.float32), cu=np.zeros((n_rec, C, 3), np.float32),
             cspread=np.zeros((n_rec, C), np.float32), cbr=np.zeros((n_rec, C, 3), np.float32),
             ptar=np.zeros((n_rec, C, 2), np.int32), pgrow=np.zeros((n_rec, C, 2), np.float32), chost=np.zeros((n_rec, C), np.int32),
             needle=np.zeros((n_rec, 3), np.float32))
    rec_i = 0

    tree = None
    rebuild_every, skin = 4, 0.6
    for s in range(n_steps):
        t = s*dt
        xn = x_start + v*t; yn = 0.0
        phase = s % S_period

        # --- feed ink (and cells) into the top of the bore on a periodic schedule
        while next_feed < len(feed_x) and feed_x[next_feed] <= xn and n_ink < Nink_max:
            kk = next_feed; g = rng_for(1, kk % K)
            i = Nb + n_ink
            rad[i] = g.uniform(P['ink_rmin'], P['ink_rmax'])
            a, rr = g.uniform(0, 2*np.pi), (Ri - rad[i] - 0.05)*np.sqrt(g.uniform())
            pos[i] = [xn + rr*np.cos(a), yn + rr*np.sin(a), ztip + 3.0 + g.uniform(0, 1.5)]
            active[i] = True
            n_ink += 1
            if kk % P['cell_every'] == 0 and n_cell < C:
                c = n_cell; gc = rng_for(2, kk % K)
                a = gc.uniform(0, 2*np.pi); rr = (Ri - rc - 0.05)*np.sqrt(gc.uniform())
                cpos[c] = [xn + rr*np.cos(a), yn + rr*np.sin(a), ztip + 3.0 + gc.uniform(0, 1.5)]
                cact[c] = True; cstate[c] = 0; ct_born[c] = t
                c_tau_att[c] = gc.uniform(*P['tau_att']); c_tau_br[c] = gc.uniform(*P['tau_br'])
                cspeed[c] = gc.uniform(0.35, 0.6); cpid[c] = kk % K
                n_cell += 1
            next_feed += 1

        # --- neighbour list over active granules + suspended cells
        if tree is None or s % rebuild_every == 0:
            gi = np.nonzero(active)[0]
            ci = np.nonzero(cact & (cstate == 0))[0]
            allpos = np.vstack([pos[gi], cpos[ci]]); allr = np.concatenate([rad[gi], np.full(len(ci), rc)])
            tree = cKDTree(wrap(allpos), boxsize=[Xmax, BIG, BIG])
            pairs = tree.query_pairs(2*rad.max() + skin, output_type='ndarray')
            nA = len(allpos)
            ginv = np.concatenate([np.where(fixed[gi], 0.0, 1.0), np.full(len(ci), 1/P['cell_gamma'])])
            inklike = np.concatenate([typ[gi] == 1, np.ones(len(ci), bool)])
        allpos = np.vstack([pos[gi], cpos[ci]])

        F = contact_forces(allpos, allr, pairs, Xmax, k) + wall_forces(allpos, allr, Y, H, k)
        near = (np.abs(allpos[:,0] - xn) < Rn + 2.5) & (np.abs(allpos[:,1] - yn) < Rn + 2.5)
        if near.any():
            F[near] += needle_forces(allpos[near], allr[near], inklike[near], xn, yn, P)

        # --- cell contraction: bridging cells pull host and target together
        br = np.nonzero(cact & (cstate == 3))[0]
        if len(br):
            row = np.full(Ntot, -1); row[gi] = np.arange(len(gi))
            for slot in range(2):
                tt = ctar[br, slot]; ok = (tt >= 0) & (cgrow[br, slot] >= 1.0)
                if not ok.any(): continue
                hh = chost[br[ok]]; tt = tt[ok]
                keep = (row[hh] >= 0) & (row[tt] >= 0)
                hh, tt = hh[keep], tt[keep]
                if len(hh) == 0: continue
                cc_ = br[ok][keep]
                dv = pos[tt] - pos[hh]; dv[:,0] -= Xmax*np.round(dv[:,0]/Xmax)
                dist = np.linalg.norm(dv, axis=1) + 1e-9
                gap = dist - rad[tt] - rad[hh]
                rest = cgap0[cc_, slot]*np.clip(1 - (t - ctg[cc_, slot])/P['tau_c'], 0, 1)
                fmag = np.clip(P['k_cell']*(gap - rest), -0.05, P['Fc'])
                fv = (fmag/dist)[:,None]*dv
                rh, rt = row[hh], row[tt]
                for cc in range(3):
                    F[:,cc] += np.bincount(rh, weights=fv[:,cc], minlength=nA) - np.bincount(rt, weights=fv[:,cc], minlength=nA)

        # --- integrate (overdamped: velocity = F/γ)
        allpos = allpos + np.clip(kg*dt*F*ginv[:,None], -0.25, 0.25)
        allpos[:,0] = np.mod(allpos[:,0], Xmax)
        pos[gi] = allpos[:len(gi)]
        cpos[ci] = allpos[len(gi):]

        # --- cells: state machine
        live = np.nonzero(cact)[0]
        if len(live):
            age = t - ct_born[live]
            sus = live[(cstate[live] == 0) & (age >= c_tau_att[live])]
            if len(sus):                                          # suspended → attach (prefer ink granules)
                dd_, ii_ = tree.query(wrap(cpos[sus]), k=8)
                for n, c in enumerate(sus):
                    cand = ii_[n]; cand = cand[cand < len(gi)]
                    if len(cand) == 0: continue
                    gids = gi[cand]
                    uu = cpos[c] - pos[gids]; uu[:,0] -= Xmax*np.round(uu[:,0]/Xmax)
                    h = gids[np.argmin(np.linalg.norm(uu, axis=1) - 2.0*(typ[gids] == 1))]
                    chost[c] = h; cstate[c] = 1; ct_att[c] = t
                    u = cpos[c] - pos[h]; u[0] -= Xmax*np.round(u[0]/Xmax); nu = np.linalg.norm(u)
                    cu[c] = u/nu if nu > 1e-6 else np.array([0, 0, 1.0])
                    g = rng_for(4, cpid[c]); tv = g.normal(0, 1, 3); tv -= tv.dot(cu[c])*cu[c]; ctv[c] = tv/np.linalg.norm(tv)
            att = live[cstate[live] >= 1]
            if len(att):
                spread = np.clip((t - ct_att[att])/P['spread_s'], 0, 1)
                mig = att[(spread >= 0.6) & (cstate[att] <= 2)]      # spread → crawl (persistent random walk)
                cstate[mig] = 2
                if len(mig):
                    noise = rng_for(5, phase).normal(0, 1, (K, 3))[cpid[mig] % K]
                    u = cu[mig]
                    tv = ctv[mig] + 0.35*np.sqrt(dt)*noise
                    tv -= np.sum(tv*u, axis=1)[:,None]*u
                    tv /= np.linalg.norm(tv, axis=1)[:,None] + 1e-9
                    u = u + (cspeed[mig]*dt/rad[chost[mig]])[:,None]*tv
                    u /= np.linalg.norm(u, axis=1)[:,None]
                    tv -= np.sum(tv*u, axis=1)[:,None]*u
                    cu[mig] = u; ctv[mig] = tv/(np.linalg.norm(tv, axis=1)[:,None] + 1e-9)
                tob = att[(cstate[att] == 2) & ((t - ct_att[att]) >= c_tau_br[att])]
                for c in tob:                                         # reach across a void, facing the cell
                    hh = chost[c]
                    cand = tree.query_ball_point(wrap(pos[hh][None])[0], rad[hh] + rad.max() + P['reach'])
                    cand = np.array([x for x in cand if x < len(gi)], dtype=int)
                    gids = gi[cand]; gids = gids[gids != hh]
                    if len(gids) == 0: c_tau_br[c] += 1.0; continue
                    dv = pos[gids] - pos[hh]; dv[:,0] -= Xmax*np.round(dv[:,0]/Xmax)
                    dist = np.linalg.norm(dv, axis=1)
                    gap = dist - rad[gids] - rad[hh]
                    cosang = (dv @ cu[c])/dist
                    okm = (gap > P['gap_min']) & (gap < P['reach']) & (cosang > 0.25)
                    if not okm.any(): c_tau_br[c] += 0.8; continue
                    score = 0.4*np.abs(gap[okm] - 1.0) - 1.2*(typ[gids[okm]] == 1) - 1.5*cosang[okm]
                    chosen = gids[okm][np.argsort(score)[:2]]
                    ctar[c] = -1; cgrow[c] = 0; ctg[c] = -1
                    ctar[c, :len(chosen)] = chosen
                    cstate[c] = 3
                brc = att[cstate[att] == 3]
                if len(brc):                                          # grow, contract, turn toward targets, drop torn bridges
                    was = cgrow[brc] < 1.0
                    cgrow[brc] = np.minimum(cgrow[brc] + dt/P['grow_s']*(ctar[brc] >= 0), 1.0)
                    done = was & (cgrow[brc] >= 1.0) & (ctar[brc] >= 0)
                    for c, slot in zip(*np.nonzero(done)):
                        c = brc[c]; tt_ = ctar[c, slot]; hh_ = chost[c]
                        dv = pos[tt_] - pos[hh_]; dv[0] -= Xmax*np.round(dv[0]/Xmax)
                        cgap0[c, slot] = max(np.linalg.norm(dv) - rad[tt_] - rad[hh_], 0.0); ctg[c, slot] = t
                    for c in brc:
                        tt = ctar[c][ctar[c] >= 0]
                        if len(tt) == 0: cstate[c] = 2; c_tau_br[c] = t - ct_att[c] + 1.5; continue
                        dv = pos[tt] - pos[chost[c]]; dv[:,0] -= Xmax*np.round(dv[:,0]/Xmax)
                        dist = np.linalg.norm(dv, axis=1)
                        gap = dist - rad[tt] - rad[chost[c]]
                        for slot in range(2):
                            if ctar[c, slot] >= 0 and gap[tt == ctar[c, slot]][0] > P['reach'] + 1.2:
                                ctar[c, slot] = -1; cgrow[c, slot] = 0; ctg[c, slot] = -1
                        dirn = (dv/dist[:,None]).mean(axis=0); nn = np.linalg.norm(dirn)
                        if nn > 1e-6:
                            u = cu[c] + 1.2*dt*(dirn/nn - cu[c]); cu[c] = u/np.linalg.norm(u)
                h = chost[att]                                        # attached cells sit on their host's surface
                cpos[att] = pos[h] + cu[att]*(rad[h] + 0.55*rc)[:,None]

        # --- record
        if s >= rec_from and (s - rec_from) % sub == 0 and rec_i < n_rec:
            R['gpos'][rec_i] = pos
            R['cpos'][rec_i] = np.where(cact[:,None], cpos, [0, 0, -60.0])
            R['cu'][rec_i] = cu
            sp = np.where(cstate >= 1, np.clip((t - ct_att)/P['spread_s'], 0, 1), 0.0); sp[~cact] = 0
            R['cspread'][rec_i] = sp
            bd = np.zeros((C, 3))                                     # bridge direction (elongates the body)
            for c in np.nonzero(cact & (cstate == 3))[0]:
                tt = ctar[c][ctar[c] >= 0]
                if len(tt):
                    dv = pos[tt] - cpos[c]; dv[:,0] -= Xmax*np.round(dv[:,0]/Xmax)
                    dv /= np.linalg.norm(dv, axis=1)[:,None] + 1e-9
                    bd[c] = dv.mean(axis=0)
            R['cbr'][rec_i] = bd
            R['ptar'][rec_i] = np.where(cact[:,None] & (cstate[:,None] == 3), ctar, -1)
            R['pgrow'][rec_i] = cgrow
            R['chost'][rec_i] = np.where(cact, chost, -1)
            R['needle'][rec_i] = [xn, yn, ztip]
            rec_i += 1
        if s % (fps*sub) == 0:
            inbore = active & (typ == 1) & (pos[:,2] > ztip) & (np.hypot(pos[:,0] - xn, pos[:,1] - yn) < Ri)
            print(f'  t={t:6.2f}s  x_needle={xn:7.2f}  ink={n_ink:4d} (in bore {inbore.sum():3d})  cells={n_cell:3d}  '
                  f'bridging={(cact & (cstate == 3)).sum():3d}  rec={rec_i:3d}  ({time.time()-t0:.0f}s)', flush=True)

    meta = dict(P=P, L=L, Nb=Nb, Nt=Nt, Ntot=Ntot, C=C, Xmax=Xmax, loop_frames=loop_frames, extra=EX, x0=x0, rec=rec_i)
    np.savez_compressed(out, rad=rad.astype(np.float32), typ=typ, meta=json.dumps(meta), **R)
    print(f'saved {out}: {rec_i} frames, {Nb} bath + {n_ink} ink granules, {n_cell} cells  ({time.time()-t0:.0f}s)')

if __name__ == '__main__':
    out = sys.argv[1] if len(sys.argv) > 1 else 'hero_sim.npz'
    run(P, out, quick='--quick' in sys.argv)
