### PSF / optical section (model vs textbook formula)

| Objective | Pinhole | Pinhole at sample (um) | Lateral FWHM (um) | z FWHM on-axis (um) | z FWHM plane-integrated (um) | In-focus pass | Textbook z FWHM (um) |
|---|---|---|---|---|---|---|---|
| Plan Apo lambda 10x/0.45 | 0.5 AU | 0.78 | 0.52 | 3.2 | 5.1 | 0.63 | 5.4 |
| Plan Apo lambda 10x/0.45 | 1 AU | 1.57 | 0.62 | 4.0 | 7.1 | 0.98 | 6.8 |
| Plan Apo lambda 10x/0.45 | 2 AU | 3.13 | 0.64 | 4.4 | 14.5 | 1.00 | 10.9 |
| Plan Apo lambda 10x/0.45 | 4 AU | 6.27 | 0.66 | 4.4 | 28.0 | 1.00 | 20.3 |
| Plan Apo lambda 20x/0.75 | 0.5 AU | 0.47 | 0.32 | 1.2 | 1.9 | 0.63 | 1.7 |
| Plan Apo lambda 20x/0.75 | 1 AU | 0.94 | 0.40 | 1.5 | 2.6 | 0.98 | 2.3 |
| Plan Apo lambda 20x/0.75 | 2 AU | 1.88 | 0.42 | 1.6 | 5.3 | 1.00 | 3.9 |
| Plan Apo lambda 20x/0.75 | 4 AU | 3.76 | 0.41 | 1.6 | 10.8 | 1.00 | 7.2 |
| Plan Apo lambda D 20x/0.80 | 0.5 AU | 0.44 | 0.30 | 1.1 | 1.6 | 0.63 | 1.5 |
| Plan Apo lambda D 20x/0.80 | 1 AU | 0.88 | 0.35 | 1.3 | 2.3 | 0.98 | 2.0 |
| Plan Apo lambda D 20x/0.80 | 2 AU | 1.76 | 0.36 | 1.4 | 4.6 | 1.00 | 3.4 |
| Plan Apo lambda D 20x/0.80 | 4 AU | 3.53 | 0.38 | 1.4 | 9.5 | 1.00 | 6.4 |

Airy unit (1.22 lambda_em/NA at 578 nm): 10x/0.45 = 1.57 um, 20x/0.75 = 0.94 um, 20x/0.80 = 0.88 um. Collection fraction into the objective (bead in water): 10x 0.029, 20x/0.75 0.087, 20x/0.80 0.101.

### Focus tolerance of each metric (noise-free, 20 px per bead, sigma = 1000 PE/um^2)

| Setting | z FWHM on-axis / plane-integrated (um) | z0 range where integrated metric stays within 5 % | Ring-mean drop at z0 = 2 um | Rim-peak drop at z0 = 2 um |
|---|---|---|---|---|
| 20x, 1 AU | 1.5 / 2.6 | -1.75 to 1.75 um | 22 % | 30 % |
| 20x, 2 AU | 1.6 / 5.3 | -1.50 to 1.50 um | 25 % | 30 % |
| 20x, 4 AU | 1.6 / 10.8 | -1.50 to 1.50 um | 18 % | 23 % |
| 10x, 1 AU | 4.0 / 7.1 | -1.50 to 1.50 um | 18 % | 20 % |
| 10x, 2 AU | 4.4 / 14.5 | -1.75 to 1.75 um | 11 % | 12 % |
| 10x, 4 AU | 4.4 / 28.0 | -4.50 to 4.50 um | 7 % | 9 % |

### Sub-pixel bead position (20x, 1 AU; swing = max/min over offsets 0 to 0.5 px)

| Pixels per bead | Pixel (um) | Rim-peak swing | Ring-mean swing | Integrated swing |
|---|---|---|---|---|
| 8 | 1.00 | 29.1 % | 34.3 % | 2.68 % |
| 12 | 0.67 | 8.3 % | 8.1 % | 1.42 % |
| 20 | 0.40 | 5.2 % | 4.5 % | 0.13 % |
| 40 | 0.20 | 2.2 % | 2.7 % | 0.00 % |

### Photon budget at 20x, 1 AU, 20 px per bead, 100 PE/um^2, 2 us dwell

| Laser at sample | Emission rate per PE at focus (photons/s) | SNR of integrated metric, one frame | PE lost per frame (phi_b = 1.1e-5) |
|---|---|---|---|
| 1 uW | 1e+07 | 40 | 0.029 % |
| 3 uW | 2.9e+07 | 67 | 0.087 % |
| 10 uW | 8e+07 | 111 | 0.290 % |
| 30 uW | 1.6e+08 | 157 | 0.868 % |

Headline (20x, 1 AU, 10 uW, 2 us, 0.4 um pixels, sigma = 1000 PE/um^2): peak irradiance 6.1 kW/cm^2, excitation rate 1.3e+08 /s per PE, emission 8e+07 photons/s per PE, detection efficiency 0.014, photoelectrons in the bead mask per frame 1.6e+05, rim pixel 946 photoelectrons, bleaching 0.29 % per frame.

### Limit of detection, PE molecules per bead (3 x shot-noise sd of a blank bead, integrated metric, 10 uW, 2 us, 20 px per bead)

| Setting | V_eff (um^3) | Detector only | Free PE-Ab 0.1 nM | 1 nM | 10 nM | Bead autofluorescence 0.1 PE-eq/um^3 | 1 | 10 |
|---|---|---|---|---|---|---|---|---|
| 20x, 1 AU | 0.5 | 16 | 37 | 106 | 331 | 28 | 73 | 227 |
| 10x, 1 AU | 3.7 | 21 | 49 | 139 | 436 | 32 | 79 | 241 |
| 10x, 4 AU | 11.2 | 14 | 52 | 158 | 499 | 23 | 60 | 186 |

### Binding-model defaults

K_D1 (analyte to capture) = 1 nM, K_D2 (detection Ab to analyte) = 10 nM; 5000 beads of 1e6 sites in 50 uL = capture capacity 166 pM; diffusion-limited rate per bead: analyte 3e+12, detection Ab 1.2e+12 M^-1 s^-1; Damkohler (empty bead) 0.03 / 0.08; apparent K_D of the PE isotherm at D0 = 0.1 / 1 / 10 nM: 0.99 / 0.91 / 0.500 nM.
