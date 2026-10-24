"""Generate the figures and the numbers table for the PE-bead confocal model report."""
import json, os, sys, time
import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from binding import BeadAssay, pe_density
from optics import (OBJ, PE, ScanSettings, BeadState, render, psf_fwhm_zeiss, ConfocalPSF, emission_rate_per_molecule,
                    bleach_fraction_per_frame, integrated_analytic, airy_unit_um)

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'figures')
os.makedirs(OUT, exist_ok=True)
CAT = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948']   # fixed order
SEQ = plt.get_cmap('Blues')
plt.rcParams.update({'font.size': 9, 'axes.spines.top': False, 'axes.spines.right': False,
                     'axes.grid': True, 'grid.color': '#e6e6e3', 'grid.linewidth': 0.6, 'lines.linewidth': 1.8,
                     'legend.frameon': False, 'figure.dpi': 130, 'savefig.dpi': 170, 'axes.titleweight': 'bold',
                     'axes.titlesize': 9, 'figure.constrained_layout.use': True})
RESULTS = json.load(open(os.path.join(OUT, 'results.json'), encoding='utf-8')) if os.path.exists(os.path.join(OUT, 'results.json')) else {}
ONLY = set(sys.argv[1:])
t0 = time.time()


def want(key):
    return not ONLY or str(key) in ONLY


def say(msg):
    print('[%5.1fs] %s' % (time.time() - t0, msg), flush=True)


def fov_for(ppb):
    return int(np.ceil(ppb * 2.1 / 2) * 2 + 8)


# ------------------------------------------------------------------ Figure 1: binding
if want('1'):
    say('fig 1 binding')
    fig, ax = plt.subplots(2, 2, figsize=(9, 7.4))
    A = np.logspace(-13, -7, 31)
    a = BeadAssay()
    for i, D0 in enumerate([1e-10, 1e-9, 1e-8]):
        eq = a.curve(A, D0, 24 * 3600) / a.S_T
        ax[0, 0].plot(A * 1e12, eq, color=CAT[i], label='D0 = %g nM, 24 h, depletion' % (D0 * 1e9))
        ax[0, 0].plot(A * 1e12, a.sad_eq_excessD(A, D0) / a.S_T, color=CAT[i], ls='--', lw=1.1,
                      label='excess-D closed form' if i == 0 else None)
    ax[0, 0].axvline(a.capacity_M * 1e12, color='#52514e', lw=0.8, ls=':')
    ax[0, 0].text(a.capacity_M * 1e12 * 1.15, 0.80, 'bead capacity\n(%d pM)' % round(a.capacity_M * 1e12), fontsize=7.5, color='#52514e', transform=ax[0, 0].get_xaxis_transform())
    ax[0, 0].set(xscale='log', xlabel='analyte added, A0 (pM)', ylabel='PE coverage  SAD / S_T',
                 title='a  Coverage isotherm: pre-complex route included')
    ax[0, 0].legend(fontsize=7.5)
    RESULTS['binding'] = dict(KD1_nM=a.KD1 * 1e9, KD2_nM=a.KD2 * 1e9, capacity_pM=a.capacity_M * 1e12,
                              kD_A=a.kD(a.D_A), kD_D=a.kD(a.D_D), Da_A=a.damkohler()[0], Da_D=a.damkohler()[1],
                              apparent_KD_nM={('%g' % (D * 1e9)): a.apparent_KD(D) * 1e9 for D in [1e-10, 1e-9, 1e-8]})

    A2 = np.logspace(-12, -6, 31)
    for i, t_inc in enumerate([3600, 2 * 3600, 24 * 3600]):
        c = a.curve(A2, 1e-9, t_inc) / a.S_T
        ax[0, 1].plot(A2 * 1e9, c, color=CAT[i], label='incubation %g h' % (t_inc / 3600))
    ax[0, 1].axvline(1.0, color='#52514e', lw=0.8, ls=':')
    ax[0, 1].text(1.15, 0.92, 'A0 = D0', fontsize=7.5, color='#52514e', transform=ax[0, 1].get_xaxis_transform())
    ax[0, 1].set(xscale='log', xlabel='analyte added, A0 (nM)   [D0 = 1 nM]', ylabel='PE coverage  SAD / S_T',
                 title='b  Hook: analyte above the detection antibody')
    ax[0, 1].legend(fontsize=7.5)

    # post-wash decay
    t_obs = np.linspace(0, 4 * 3600, 200)
    for i, km2 in enumerate([1e-2, 1e-3, 1e-4]):
        b = BeadAssay(km2=km2)
        inc = b.incubate(1e-10, 1e-9, 2 * 3600)
        w = b.wash(inc.y[:, -1], t_obs[-1], t_eval=t_obs)
        ax[1, 0].plot(t_obs / 60, w.y[4] / w.y[4, 0], color=CAT[i],
                      label='k$_{-2}$ = %g s$^{-1}$  (decay rate k$_{-2}$+k$_{-3}$ = %.2g)' % (km2, km2 + b.km3))
    ax[1, 0].set(xlabel='time after wash (min)', ylabel='PE on bead / PE at wash', yscale='log', ylim=(1e-2, 1.2),
                 title='c  After the wash: PE leaves at k$_{-2}$ + k$_{-3}$')
    ax[1, 0].legend(fontsize=7.5)

    # transport limitation
    t_inc = np.linspace(0, 2 * 3600, 200)
    for i, (k1, S_T, lab) in enumerate([(1e5, 1e6, 'k1 = 1e5, S_T = 1e6'), (1e6, 1e6, 'k1 = 1e6, S_T = 1e6'), (1e6, 5e6, 'k1 = 1e6, S_T = 5e6')]):
        for tr, ls in [(True, '-'), (False, '--')]:
            b = BeadAssay(k1=k1, S_T=S_T, transport=tr)
            inc = b.incubate(1e-10, 1e-9, t_inc[-1], t_eval=t_inc)
            ax[1, 1].plot(t_inc / 60, inc.y[4], color=CAT[i], ls=ls,
                          label=('%s  Da=%.2f' % (lab, b.damkohler()[0])) if tr else None)
    ax[1, 1].plot([], [], color='#52514e', ls='--', label='same, transport switched off')
    ax[1, 1].set(xlabel='incubation time (min)   [A0 = 100 pM, D0 = 1 nM]', ylabel='PE per bead',
                 title='d  Diffusion to the bead (Berg-Purcell factor)')
    ax[1, 1].legend(fontsize=7)
    fig.savefig(os.path.join(OUT, 'fig1_binding.png'))
    plt.close(fig)

# ------------------------------------------------------------------ PSF table
if want('psf'):
    say('psf table')
    RESULTS['psf'] = {}
    for key in ('10x', '20x', '20xD'):
        RESULTS['psf'][key] = dict(name=OBJ[key].name, AU_um=airy_unit_um(OBJ[key]), collection=OBJ[key].collection_fraction())
        for AU in (0.5, 1, 2, 4):
            fxy, fz, PH = psf_fwhm_zeiss(OBJ[key], AU)
            p = ConfocalPSF(OBJ[key], AU)
            RESULTS['psf'][key]['AU%g' % AU] = dict(pinhole_um=PH, zeiss_fwhm_xy=fxy, zeiss_fwhm_z=fz, model_fwhm_xy=p.fwhm_xy(),
                                                     model_fwhm_z_onaxis=p.fwhm_z_onaxis(), model_fwhm_z_sea=p.fwhm_z_sea(), in_focus_pass=p.D00(),
                                                     w0_um=p.w0, zR_um=p.zR)

# ------------------------------------------------------------------ Figure 2: gallery
if want('2'):
    say('fig 2 gallery')
    rows = [('10x, 1 AU, shell', ScanSettings(objective='10x', pinhole_AU=1), 'shell'),
            ('10x, 2 AU, shell', ScanSettings(objective='10x', pinhole_AU=2), 'shell'),
            ('20x, 1 AU, shell', ScanSettings(objective='20x', pinhole_AU=1), 'shell'),
            ('20x, 4 AU, shell', ScanSettings(objective='20x', pinhole_AU=4), 'shell'),
            ('20x, 1 AU, volume-stained', ScanSettings(objective='20x', pinhole_AU=1), 'volume')]
    z0s = [0.0, 2.0, 3.5]
    fig, ax = plt.subplots(len(rows), len(z0s), figsize=(7.2, 11.6))
    for r, (lab, scan, kind) in enumerate(rows):
        scan.px_per_bead = 20
        imgs = [render(BeadState(sigma_PE_um2=1000, z0_um=z0, kind=kind), scan, fov_px=fov_for(20), seed=r * 10 + c) for c, z0 in enumerate(z0s)]
        vmax = max(np.percentile(im['image'], 99.9) for im in imgs)
        for c, (z0, im) in enumerate(zip(z0s, imgs)):
            ax[r, c].imshow(im['image'], cmap='gray', vmin=scan.offset_DN, vmax=vmax, interpolation='nearest')
            ax[r, c].set_xticks([]); ax[r, c].set_yticks([]); ax[r, c].grid(False)
            ax[r, c].set_title('z0 = %.1f um   ring r = %.1f um\nint %.3g  peak/centre %.1f' % (z0, im['ring_r_um'], im['integrated'], min(im['contrast'], 999)), fontsize=7.5, fontweight='normal')
            if c == 0:
                ax[r, c].set_ylabel(lab + '\nz FWHM on-axis %.1f / sea %.1f um' % (im['fwhm_z'], im['fwhm_z_sea']), fontsize=8)
    fig.savefig(os.path.join(OUT, 'fig2_gallery.png'))
    plt.close(fig)

# ------------------------------------------------------------------ Figure 3: metrics vs z0
if want('3'):
    say('fig 3 metrics vs z0')
    settings = [('20x, 1 AU', ScanSettings(objective='20x', pinhole_AU=1)),
                ('20x, 2 AU', ScanSettings(objective='20x', pinhole_AU=2)),
                ('20x, 4 AU', ScanSettings(objective='20x', pinhole_AU=4)),
                ('10x, 1 AU', ScanSettings(objective='10x', pinhole_AU=1)),
                ('10x, 2 AU', ScanSettings(objective='10x', pinhole_AU=2)),
                ('10x, 4 AU', ScanSettings(objective='10x', pinhole_AU=4))]
    z0s = np.linspace(-4.5, 4.5, 37)
    fig, ax = plt.subplots(2, 2, figsize=(9, 7))
    RESULTS['z0_invariance'] = {}
    for i, (lab, scan) in enumerate(settings):
        scan.px_per_bead = 20
        rows_ = [render(BeadState(sigma_PE_um2=1000, z0_um=z0), scan, fov_px=fov_for(20), noise=False) for z0 in z0s]
        I = np.array([r['integrated'] for r in rows_]); Rm = np.array([r['ring_mean'] for r in rows_])
        Pk = np.array([r['peak'] for r in rows_]); Rr = np.array([r['ring_r_um'] for r in rows_])
        ref = I[len(z0s) // 2]
        ax[0, 0].plot(z0s, I / ref, color=CAT[i], label='%s (z FWHM on-axis %.1f, sea %.1f um)' % (lab, rows_[0]['fwhm_z'], rows_[0]['fwhm_z_sea']))
        ax[0, 1].plot(z0s, Rm / Rm[len(z0s) // 2], color=CAT[i], label=lab)
        ax[1, 0].plot(z0s, Pk / Pk[len(z0s) // 2], color=CAT[i], label=lab)
        ax[1, 1].plot(z0s, Rr, color=CAT[i], label=lab)
        half = z0s[(I / ref) >= 0.95]
        RESULTS['z0_invariance'][lab] = dict(fwhm_z=rows_[0]['fwhm_z'], fwhm_z_sea=rows_[0]['fwhm_z_sea'], z0_range_within_5pct_um=[float(half.min()), float(half.max())] if len(half) else None,
                                             ring_mean_drop_at_2um=float(1 - Rm[np.argmin(abs(z0s - 2))] / Rm[len(z0s) // 2]),
                                             peak_drop_at_2um=float(1 - Pk[np.argmin(abs(z0s - 2))] / Pk[len(z0s) // 2]))
    ax[1, 1].plot(z0s, np.sqrt(np.maximum(16 - z0s ** 2, 0)), color='#52514e', ls=':', lw=1, label='geometric  sqrt(R^2 - z0^2)')
    for a_, t_, yl in [(ax[0, 0], 'a  Integrated intensity over the bead mask', 'relative to z0 = 0'),
                       (ax[0, 1], 'b  Ring-mean intensity', 'relative to z0 = 0'),
                       (ax[1, 0], 'c  Rim peak intensity', 'relative to z0 = 0'),
                       (ax[1, 1], 'd  Apparent ring radius', 'um')]:
        a_.set(title=t_, xlabel='focal-plane offset from bead centre, z0 (um)', ylabel=yl)
        a_.legend(fontsize=7.5)
    ax[0, 0].axhline(0.95, color='#52514e', lw=0.7, ls=':')
    fig.savefig(os.path.join(OUT, 'fig3_metrics_vs_z0.png'))
    plt.close(fig)

# ------------------------------------------------------------------ Figure 4: sampling and sub-pixel offset
if want('4'):
    say('fig 4 sampling')
    fig, ax = plt.subplots(1, 3, figsize=(11.5, 3.6))
    offs = np.linspace(0, 0.5, 6)
    RESULTS['sampling'] = {}
    for i, ppb in enumerate([8, 12, 20, 40]):
        scan = ScanSettings(objective='20x', pinhole_AU=1, px_per_bead=ppb)
        rows_ = [render(BeadState(sigma_PE_um2=1000, xy_off_px=(o, o * 0.6)), scan, fov_px=fov_for(ppb), noise=False) for o in offs]
        pk = np.array([r['peak'] for r in rows_]); I = np.array([r['integrated'] for r in rows_]); rm = np.array([r['ring_mean'] for r in rows_])
        ax[0].plot(offs, pk / pk[0], color=CAT[i], marker='o', ms=4, label='%d px per bead (%.2f um px)' % (ppb, rows_[0]['px_um']))
        ax[1].plot(offs, I / I[0], color=CAT[i], marker='o', ms=4, label='%d px per bead' % ppb)
        RESULTS['sampling'][ppb] = dict(px_um=rows_[0]['px_um'], peak_swing=float(pk.max() / pk.min() - 1), ring_mean_swing=float(rm.max() / rm.min() - 1),
                                        integrated_swing=float(I.max() / I.min() - 1))
    ax[0].set(title='a  Rim peak vs sub-pixel position', xlabel='bead centre offset from a pixel centre (px)', ylabel='relative to zero offset')
    ax[1].set(title='b  Integrated vs sub-pixel position', xlabel='bead centre offset from a pixel centre (px)', ylabel='relative to zero offset', ylim=(0.9, 1.1))
    ax[0].legend(fontsize=7); ax[1].legend(fontsize=7)
    ppbs = np.array([6, 8, 10, 12, 16, 20, 28, 40])
    snr, bl = [], []
    for ppb in ppbs:
        scan = ScanSettings(objective='20x', pinhole_AU=1, px_per_bead=ppb)
        r = render(BeadState(sigma_PE_um2=100), scan, fov_px=fov_for(ppb), noise=False)
        snr.append(r['snr_integrated']); bl.append(r['bleach_frac_per_frame'])
    ax[2].plot(ppbs, np.array(snr) / snr[0], color=CAT[0], marker='o', ms=4, label='SNR of integrated metric (per frame)')
    ax[2].plot(ppbs, np.array(bl) / bl[0], color=CAT[1], marker='s', ms=4, label='bleaching dose per frame')
    ax[2].plot(ppbs, (ppbs / ppbs[0]) ** 2, color='#52514e', ls=':', lw=1, label='(pixels per bead)^2')
    ax[2].set(title='c  Finer sampling at fixed dwell', xlabel='pixels per bead', ylabel='relative to 6 px per bead', yscale='log')
    ax[2].legend(fontsize=7)
    fig.savefig(os.path.join(OUT, 'fig4_sampling.png'))
    plt.close(fig)

# ------------------------------------------------------------------ Figure 5: photon budget, bleaching, linearity
if want('5'):
    say('fig 5 photon budget')
    fig, ax = plt.subplots(2, 2, figsize=(9, 7))
    dwells = np.array([0.1, 0.2, 0.5, 1, 2, 5, 10, 20])
    RESULTS['budget'] = {}
    for i, P in enumerate([1, 3, 10, 30]):
        snr, bl, kem = [], [], []
        for d in dwells:
            scan = ScanSettings(objective='20x', pinhole_AU=1, px_per_bead=20, laser_uW=P, dwell_us=d)
            r = render(BeadState(sigma_PE_um2=100), scan, fov_px=fov_for(20), noise=False)
            snr.append(r['snr_integrated']); bl.append(r['bleach_frac_per_frame']); kem.append(r['k_em'])
        snr, bl = np.array(snr), np.array(bl)
        ax[0, 0].plot(dwells, snr, color=CAT[i], marker='o', ms=4, label='%g uW  (k_em %.2g ph/s per PE)' % (P, kem[0]))
        ax[0, 1].plot(dwells, bl * 100, color=CAT[i], marker='o', ms=4, label='%g uW' % P)
        ax[1, 0].plot(bl * 100, snr, color=CAT[i], marker='o', ms=4, label='%g uW' % P)
        RESULTS['budget'][P] = dict(k_em=kem[0], snr_at_2us=float(snr[dwells == 2][0]), bleach_pct_at_2us=float(bl[dwells == 2][0] * 100))
    ax[0, 0].set(title='a  SNR, integrated metric, 1 frame, 100 PE/um^2', xlabel='pixel dwell (us)', ylabel='SNR', xscale='log', yscale='log')
    ax[0, 1].set(title='b  PE lost per frame (phi_b = 1.1e-5, R-PE)', xlabel='pixel dwell (us)', ylabel='% of PE lost per frame', xscale='log', yscale='log')
    ax[1, 0].set(title='c  SNR bought per % bleached', xlabel='% of PE lost per frame', ylabel='SNR', xscale='log', yscale='log')
    for a_ in ax.flat[:3]:
        a_.legend(fontsize=7)
    # linearity / LOD
    sig = np.array([0, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000])
    RESULTS['linearity'] = {}
    for i, (lab, scan) in enumerate([('20x, 1 AU', ScanSettings(objective='20x', pinhole_AU=1, px_per_bead=20)),
                                     ('10x, 1 AU', ScanSettings(objective='10x', pinhole_AU=1, px_per_bead=20))]):
        means, sds = [], []
        for s in sig:
            vals = [render(BeadState(sigma_PE_um2=s), scan, fov_px=fov_for(20), seed=k)['integrated'] for k in range(8)]
            means.append(np.mean(vals)); sds.append(np.std(vals, ddof=1))
        means, sds = np.array(means), np.array(sds)
        slope = (means[-1] - means[0]) / sig[-1]
        lod = 3 * sds[0] / slope
        ax[1, 1].errorbar(sig[1:], means[1:] - means[0], yerr=sds[1:], color=CAT[i], marker='o', ms=4, capsize=2, label='%s   detector-only LOD %.2g PE/um^2 (%.0f PE/bead)' % (lab, lod, lod * 201))
        ax[1, 1].axhline(3 * sds[0], color=CAT[i], ls=':', lw=1)
        RESULTS['linearity'][lab] = dict(slope_DN_per_PE_um2=float(slope), blank_sd_DN=float(sds[0]), LOD_PE_um2=float(lod), LOD_PE_per_bead=float(lod * 4 * np.pi * 16),
                                         cv_at_100=float(sds[sig == 100][0] / (means[sig == 100][0] - means[0])), sat_at_5000=None)
    ax[1, 1].set(title='d  Linearity (8 beads each, %g uW, 2 us; dotted = 3 sd of blank)' % ScanSettings().laser_uW, xlabel='PE per um^2', ylabel='integrated DN above blank', xscale='log', yscale='log')
    ax[1, 1].legend(fontsize=7)
    fig.savefig(os.path.join(OUT, 'fig5_photon_budget.png'))
    plt.close(fig)

# ------------------------------------------------------------------ Figure 6: gain
if want('6'):
    say('fig 6 gain')
    gains = np.array([1, 2, 5, 10, 20, 50, 100, 200, 500])
    fig, ax = plt.subplots(1, 2, figsize=(8, 3.4))
    RESULTS['gain'] = {}
    for i, s in enumerate([30, 300, 3000]):
        m, cv, sat = [], [], []
        for g in gains:
            scan = ScanSettings(objective='20x', pinhole_AU=1, px_per_bead=20, gain=g)
            vals, sf = [], []
            for k in range(12):
                r = render(BeadState(sigma_PE_um2=s), scan, fov_px=fov_for(20), seed=k)
                vals.append(r['integrated'] / g); sf.append(r['saturated_frac'])
            m.append(np.mean(vals)); cv.append(np.std(vals, ddof=1) / np.mean(vals)); sat.append(np.mean(sf))
        m, cv, sat = np.array(m), np.array(cv), np.array(sat)
        ax[0].plot(gains, m / m[2], color=CAT[i], marker='o', ms=4, label='%g PE/um^2' % s)
        ax[1].plot(gains, cv * 100, color=CAT[i], marker='o', ms=4, label='%g PE/um^2' % s)
        RESULTS['gain'][s] = dict(first_gain_with_clipping=float(gains[sat > 0][0]) if (sat > 0).any() else None)
    ax[0].set(title='a  Integrated photoelectrons recovered vs gain', xlabel='gain (DN per photoelectron)', ylabel='relative to gain 5', xscale='log')
    ax[1].set(title='b  Bead-to-bead CV of the integrated metric', xlabel='gain (DN per photoelectron)', ylabel='CV (%)', xscale='log', yscale='log')
    ax[0].legend(fontsize=7); ax[1].legend(fontsize=7)
    fig.savefig(os.path.join(OUT, 'fig6_gain.png'))
    plt.close(fig)

# ------------------------------------------------------------------ Figure 7: radial profiles
if want('7'):
    say('fig 7 profiles')
    fig, ax = plt.subplots(1, 2, figsize=(9, 3.6))
    for j, (lab, scan) in enumerate([('20x, 1 AU', ScanSettings(objective='20x', pinhole_AU=1, px_per_bead=40)),
                                     ('10x, 1 AU', ScanSettings(objective='10x', pinhole_AU=1, px_per_bead=40))]):
        z0s = [0, 1, 2, 3, 3.5]
        for i, z0 in enumerate(z0s):
            r = render(BeadState(sigma_PE_um2=1000, z0_um=z0), scan, fov_px=fov_for(40), noise=False)
            rr, prof = r['profile']
            ax[j].plot(rr, prof / scan.gain, color=SEQ(0.35 + 0.65 * i / (len(z0s) - 1)), label='z0 = %.1f um' % z0)
        ax[j].set(title='%s  radial profile (z FWHM on-axis %.1f, sea %.1f um)' % (chr(97 + j) + '  ' + lab, r['fwhm_z'], r['fwhm_z_sea']), xlabel='distance from bead centre (um)', ylabel='photoelectrons per pixel')
        ax[j].legend(fontsize=7)
    fig.savefig(os.path.join(OUT, 'fig7_profiles.png'))
    plt.close(fig)

# ------------------------------------------------------------------ Figure 8: field position
if want('8'):
    say('fig 8 field')
    fig, ax = plt.subplots(1, 2, figsize=(8, 3.4))
    rf = np.linspace(0, 1, 11)
    for i, (lab, scan, fc) in enumerate([('20x, 1 AU, field curvature 1 um at edge', ScanSettings(objective='20x', pinhole_AU=1), 1.0),
                                         ('20x, 1 AU, field curvature 3 um at edge', ScanSettings(objective='20x', pinhole_AU=1), 3.0),
                                         ('10x, 1 AU, field curvature 3 um at edge', ScanSettings(objective='10x', pinhole_AU=1), 3.0)]):
        scan.px_per_bead = 20
        I, rm = [], []
        for r_ in rf:
            r = render(BeadState(sigma_PE_um2=1000, field_r=r_, vignette=0.15, field_curv_um=fc), scan, fov_px=fov_for(20), noise=False)
            I.append(r['integrated']); rm.append(r['ring_mean'])
        I, rm = np.array(I), np.array(rm)
        ax[0].plot(rf, I / I[0], color=CAT[i], label=lab)
        ax[1].plot(rf, rm / rm[0], color=CAT[i], label=lab)
    ax[0].plot(rf, 1 - 0.15 * rf ** 2, color='#52514e', ls=':', lw=1, label='vignetting alone (15 % at edge)')
    ax[0].set(title='a  Integrated metric vs position in the field', xlabel='normalised distance from scan centre', ylabel='relative to centre')
    ax[1].set(title='b  Ring-mean metric vs position in the field', xlabel='normalised distance from scan centre', ylabel='relative to centre')
    ax[0].legend(fontsize=6.5); ax[1].legend(fontsize=6.5)
    fig.savefig(os.path.join(OUT, 'fig8_field.png'))
    plt.close(fig)

# ------------------------------------------------------------------ Figure 9: backgrounds, no-wash feasibility
if want('9'):
    say('fig 9 backgrounds')
    fig, ax = plt.subplots(1, 2, figsize=(9, 3.6))
    RESULTS['background'] = {}
    cfgs = [('20x, 1 AU', ScanSettings(objective='20x', pinhole_AU=1, px_per_bead=20)),
            ('10x, 1 AU', ScanSettings(objective='10x', pinhole_AU=1, px_per_bead=20)),
            ('10x, 4 AU', ScanSettings(objective='10x', pinhole_AU=4, px_per_bead=20))]
    sol = np.array([0.01, 0.03, 0.1, 0.3, 1, 3, 10])
    auto = np.array([0.01, 0.03, 0.1, 0.3, 1, 3, 10])
    def lod_analytic(scan, **bead_kw):
        """3 x shot-noise sd of the blank integrated metric, converted to PE per bead (deterministic)."""
        r = render(BeadState(sigma_PE_um2=0.0, **bead_kw), scan, fov_px=fov_for(20), noise=False)
        yy, xx = np.indices(r['image'].shape)
        rr = np.hypot(xx - r['centre_px'][0], yy - r['centre_px'][1]) * r['px_um']
        mask = rr <= 4.0 + 2.5
        lam = r['mean_pe'][mask]
        var = scan.excess_noise_F * np.sum(lam) + mask.sum() * (scan.read_noise_DN / scan.gain) ** 2
        slope = integrated_analytic(BeadState(sigma_PE_um2=1.0), scan)       # photoelectrons per (PE/um^2)
        return 3 * np.sqrt(var) / slope * 4 * np.pi * 16, r
    for i, (lab, scan) in enumerate(cfgs):
        lods = [lod_analytic(scan, solution_PE_nM=c)[0] for c in sol]
        r0 = lod_analytic(scan, solution_PE_nM=1.0)[1]
        ax[0].plot(sol, lods, color=CAT[i], marker='o', ms=4, label='%s  (V_eff %.1f um^3)' % (lab, r0['Veff_um3']))
        lods2 = [lod_analytic(scan, autofluor_PE_um3=c)[0] for c in auto]
        ax[1].plot(auto, lods2, color=CAT[i], marker='o', ms=4, label=lab)
        RESULTS['background'][lab] = dict(Veff_um3=r0['Veff_um3'], detector_only_LOD_PE_per_bead=lod_analytic(scan)[0],
                                          LOD_PE_per_bead_vs_solution_nM=dict(zip(map(str, sol), lods)),
                                          LOD_PE_per_bead_vs_autofluor=dict(zip(map(str, auto), lods2)))
    ax[0].set(title='a  LOD vs free PE-antibody in the imaging buffer', xlabel='free PE-antibody (nM)', ylabel='LOD, PE molecules per bead (3 x shot-noise sd)', xscale='log', yscale='log')
    ax[1].set(title='b  LOD vs bead autofluorescence', xlabel='bead autofluorescence (PE-equivalents per um^3)', ylabel='LOD, PE molecules per bead', xscale='log', yscale='log')
    ax[0].legend(fontsize=7); ax[1].legend(fontsize=7)
    fig.savefig(os.path.join(OUT, 'fig9_backgrounds.png'))
    plt.close(fig)

    # photon-budget headline numbers
    scan = ScanSettings(objective='20x', pinhole_AU=1, px_per_bead=20)
    r = render(BeadState(sigma_PE_um2=1000), scan, fov_px=fov_for(20), noise=False)
    RESULTS['headline'] = dict(k_em=r['k_em'], k_ex=r['k_ex'], I0_W_m2=r['I0_W_m2'], eta=r['eta'], px_um=r['px_um'], fwhm_z_sea=r['fwhm_z_sea'], D00=r['D00'],
                               photoelectrons_in_mask=r['photons_in_mask'], peak_pe_per_px=float(r['peak'] / scan.gain),
                               bleach_frac_per_frame=r['bleach_frac_per_frame'], fwhm_xy=r['fwhm_xy'], fwhm_z=r['fwhm_z'])
json.dump(RESULTS, open(os.path.join(OUT, 'results.json'), 'w'), indent=1, default=float)
say('done')
