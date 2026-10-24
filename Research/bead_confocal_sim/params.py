"""Shared parameters of the PE-bead model — one place for every number the code assumes.

optics.py, binding.py, run_figures.py and tables.py read their defaults from here. The interactive pages
(interactive/src/*-engine.js) mirror the same values, and interactive/tools/check_*.py verify the mirror against
this code. Change a value here, rerun run_figures.py, and rebuild the pages.

Sources: report Research/PE_bead_confocal_assay_model.md (revision 2) — B.4.1 (R-PE), B.4.3 (detection),
D.1 (operating point), A.6 and report_calcs/partA.py (binding reference case).
"""

# R-PE: absorption at ~565 nm, quantum yield, fluorescence lifetime (2.7 ns, B.4.1), photodestruction yield
# (White & Stryer 1987; with n-propyl gallate 6.5e-6), and the wavelengths used for the PSF.
PE = dict(eps_M_cm=1.96e6, QY=0.82, tau_fl_s=2.7e-9, phi_bleach=1.1e-5, phi_bleach_npg=6.5e-6,
          lam_ex_um=0.561, lam_em_um=0.578)

# Detection chain after the objective (lumped optics x filters; GaAsP QE at ~580 nm) and the PMT.
DETECTION = dict(transmission=0.4, QE=0.40, excess_noise_F=1.3)

# The report's recommended operating point (D.1): 20x at 1 AU, 1-2 uW measured at the sample, 2 us galvano dwell,
# 2048^2 at zoom 1 (0.43 um pixels, ~18.5 per bead). The figures keep 20 px per bead and the 20x/0.75 lens for
# continuity with revision 1; the simulator page defaults to 20x/0.80 and 18.5 px. Which 20x is fitted is open.
OPERATING = dict(objective='20x', pinhole_AU=1.0, laser_uW=2.0, dwell_us=2.0, px_per_bead=20.0)

# Detector model of the simulator (DN = offset + gain x photoelectrons + read noise, 16-bit).
DETECTOR = dict(gain=20.0, offset_DN=200.0, read_noise_DN=3.0, adc_max=65535)

# Binding reference case (report A.2.4 / A.6, report_calcs/partA.py): 1e6 active capture sites per bead,
# 1e4 beads in 50 uL, capture 5e5 / 1e-5, detection 4e5 / 8.6e-4 (the biosensor off-rate; bead fits give ~1e-4),
# detection antibody 2 nM, diffusion (m^2/s) analyte 6e-11, detection antibody 3.5e-11, complex 3e-11.
BINDING = dict(k1=5e5, km1=1e-5, k2=4e5, km2=8.6e-4, S_T=1e6, R_um=4.0, n_beads=1e4, V_uL=50.0,
               D_A=6e-11, D_D=3.5e-11, D_AD=3e-11, D0_M=2e-9)
