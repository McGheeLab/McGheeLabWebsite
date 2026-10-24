"""Markdown tables of the model numbers, from figures/results.json."""
import json, os
R = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'figures', 'results.json'), encoding='utf-8'))
out = []
out.append('### PSF / optical section (model vs textbook formula)\n')
out.append('| Objective | Pinhole | Pinhole at sample (um) | Lateral FWHM (um) | z FWHM on-axis (um) | z FWHM plane-integrated (um) | In-focus pass | Textbook z FWHM (um) |')
out.append('|---|---|---|---|---|---|---|---|')
for key in ('10x', '20x', '20xD'):
    o = R['psf'][key]
    for AU in ('0.5', '1', '2', '4'):
        d = o['AU' + AU]
        out.append('| %s | %s AU | %.2f | %.2f | %.1f | %.1f | %.2f | %.1f |' % (o['name'], AU, d['pinhole_um'], d['model_fwhm_xy'], d['model_fwhm_z_onaxis'], d['model_fwhm_z_sea'], d['in_focus_pass'], d['zeiss_fwhm_z']))
out.append('\nAiry unit (1.22 lambda_em/NA at 578 nm): 10x/0.45 = %.2f um, 20x/0.75 = %.2f um, 20x/0.80 = %.2f um. Collection fraction into the objective (bead in water): 10x %.3f, 20x/0.75 %.3f, 20x/0.80 %.3f.\n' % (
    R['psf']['10x']['AU_um'], R['psf']['20x']['AU_um'], R['psf']['20xD']['AU_um'], R['psf']['10x']['collection'], R['psf']['20x']['collection'], R['psf']['20xD']['collection']))
out.append('### Focus tolerance of each metric (noise-free, 20 px per bead, sigma = 1000 PE/um^2)\n')
out.append('| Setting | z FWHM on-axis / plane-integrated (um) | z0 range where integrated metric stays within 5 % | Ring-mean drop at z0 = 2 um | Rim-peak drop at z0 = 2 um |')
out.append('|---|---|---|---|---|')
for k, d in R['z0_invariance'].items():
    rng = d['z0_range_within_5pct_um']
    out.append('| %s | %.1f / %.1f | %s | %.0f %% | %.0f %% |' % (k, d['fwhm_z'], d['fwhm_z_sea'], ('%.2f to %.2f um' % tuple(rng)) if rng else 'none', d['ring_mean_drop_at_2um'] * 100, d['peak_drop_at_2um'] * 100))
out.append('\n### Sub-pixel bead position (20x, 1 AU; swing = max/min over offsets 0 to 0.5 px)\n')
out.append('| Pixels per bead | Pixel (um) | Rim-peak swing | Ring-mean swing | Integrated swing |')
out.append('|---|---|---|---|---|')
for k, d in R['sampling'].items():
    out.append('| %s | %.2f | %.1f %% | %.1f %% | %.2f %% |' % (k, d['px_um'], d['peak_swing'] * 100, d['ring_mean_swing'] * 100, d['integrated_swing'] * 100))
out.append('\n### Photon budget at 20x, 1 AU, 20 px per bead, 100 PE/um^2, 2 us dwell\n')
out.append('| Laser at sample | Emission rate per PE at focus (photons/s) | SNR of integrated metric, one frame | PE lost per frame (phi_b = 1.1e-5) |')
out.append('|---|---|---|---|')
for k, d in R['budget'].items():
    out.append('| %s uW | %.2g | %.0f | %.3f %% |' % (k, d['k_em'], d['snr_at_2us'], d['bleach_pct_at_2us']))
h = R['headline']
out.append('\nHeadline (20x, 1 AU, 10 uW, 2 us, 0.4 um pixels, sigma = 1000 PE/um^2): peak irradiance %.1f kW/cm^2, excitation rate %.2g /s per PE, emission %.2g photons/s per PE, detection efficiency %.3f, photoelectrons in the bead mask per frame %.3g, rim pixel %.0f photoelectrons, bleaching %.2f %% per frame.\n' % (
    h['I0_W_m2'] / 1e7, h['k_ex'], h['k_em'], h['eta'], h['photoelectrons_in_mask'], h['peak_pe_per_px'], h['bleach_frac_per_frame'] * 100))
out.append('### Limit of detection, PE molecules per bead (3 x shot-noise sd of a blank bead, integrated metric, 10 uW, 2 us, 20 px per bead)\n')
out.append('| Setting | V_eff (um^3) | Detector only | Free PE-Ab 0.1 nM | 1 nM | 10 nM | Bead autofluorescence 0.1 PE-eq/um^3 | 1 | 10 |')
out.append('|---|---|---|---|---|---|---|---|---|')
for k, d in R['background'].items():
    s_ = d['LOD_PE_per_bead_vs_solution_nM']; a_ = d['LOD_PE_per_bead_vs_autofluor']
    out.append('| %s | %.1f | %.0f | %.0f | %.0f | %.0f | %.0f | %.0f | %.0f |' % (k, d['Veff_um3'], d['detector_only_LOD_PE_per_bead'], s_['0.1'], s_['1.0'], s_['10.0'], a_['0.1'], a_['1.0'], a_['10.0']))
b = R['binding']
out.append('\n### Binding-model defaults\n')
out.append('K_D1 (analyte to capture) = %.2g nM, K_D2 (detection Ab to analyte) = %.2g nM; 5000 beads of 1e6 sites in 50 uL = capture capacity %.0f pM; diffusion-limited rate per bead: analyte %.2g, detection Ab %.2g M^-1 s^-1; Damkohler (empty bead) %.2f / %.2f; apparent K_D of the PE isotherm at D0 = 0.1 / 1 / 10 nM: %.2f / %.2f / %.3f nM.' % (
    b['KD1_nM'], b['KD2_nM'], b['capacity_pM'], b['kD_A'], b['kD_D'], b['Da_A'], b['Da_D'], b['apparent_KD_nM']['0.1'], b['apparent_KD_nM']['1'], b['apparent_KD_nM']['10']))
open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'figures', 'tables.md'), 'w', encoding='utf-8').write('\n'.join(out) + '\n')
print('\n'.join(out))
