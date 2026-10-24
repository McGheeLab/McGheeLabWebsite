# PE bead confocal assay — characterization experiments for the real system

*McGhee Lab · 2026-10-24 · companion to [PE_bead_confocal_assay_model.md](PE_bead_confocal_assay_model.md) and the simulator in [bead_confocal_sim/](bead_confocal_sim/).*

**Purpose.** The model has about twenty parameters. Some come from the literature and are good enough
(R-PE extinction, quantum yield, photodestruction yield). The rest belong to *this* microscope, *these* beads
and *these* antibodies, and only measurements can set them. Each experiment below pins specific parameters
and answers a specific measurement-strategy question. The order matters: instrument first, then optics,
then photophysics, then the assay. Each block uses only numbers the blocks before it have already fixed.

**What I do with the data.** Each experiment states what it pins and what fit it feeds. The simulator
(`optics.py`, `binding.py`) is refit with the measured values, and the measurement-strategy section of the
report is re-run against the real system rather than against assumed numbers.

---

## 0 · Ground rules for every session

| Item | Setting / rule | Why |
|---|---|---|
| Warm-up | Laser and stand on **2–3 h** before quantitative work | Focus typically drifts ≈0.5 µm per 5 min (>1 µm per 10 min in a new system's first hour), and laser power by 10–25 % over 3 h [Jonkman 2020]. |
| Excitation | **561 nm** (record % and measured µW at the sample, Exp. 1) | Near the R-PE 565 nm peak. 488 nm couples through the 490 nm phycourobilins and is weaker. |
| Emission | PE band, e.g. **570–620 nm** on the DUX unit; same band always | Fixes the collected fraction of PE emission. |
| Detector | GaAsP channel if fitted; **16-bit** (needs fine integration; the default is 12-bit, so check the bit depth in the file); one HV and one offset for a whole plate | Gain changes between wells cannot be undone afterwards. |
| Offset | Set so the background mode sits **≥ 50 DN above 0** | No zero-clipped pixels, or the background estimate is biased [Jonkman 2020]. |
| Saturation | **0 saturated pixels** on the brightest bead of the plate | Saturated pixels stop counting and bias the integrated metric. |
| Focus | Find it in **transmitted light**, then hold it with **Perfect Focus**; never live-scan PE to focus | Live PE scanning is the largest uncontrolled bleaching dose [Waters 2009]. |
| Vessel | **#1.5 (0.17 mm) glass-bottom** plate or chamber, same type throughout | The 10x and 20x Lambda D lenses have a fixed 0.17 mm correction and no collar. |
| Objective | Read the **NA on the 20x barrel** (Plan Apo λD 20x is NA 0.80; 0.75 is a different model) and record it | The simulator has both; the section and collection differ by ≈15 %. |
| Settling | Wait **≥ 30 min** after adding polystyrene beads to a ~3 mm liquid column, or spin the plate briefly | An 8 µm polystyrene bead sinks at ≈1.7 µm/s (Stokes, Δρ = 0.05 g/mL). Denser beads settle faster. |
| Records | Keep the **.nd2** files (NIS stores laser %, HV, offset, pinhole, dwell, zoom, pixel size). Add **one CSV row per well**, with the columns in §6. | Every fit needs the settings. A lost setting loses the image. |
| Storage | A folder **outside this repo** (the repo is public and the files are large), e.g. `~/Documents/BeadConfocalData/<date>_<exp>/` | |
| Reference wells | On every assay plate: **PE calibration beads** + one **saturated assay-bead** well | Removes day-to-day laser and detector drift (Exp. 10). |

**Materials to have on hand:** assay beads (capture antibody), blank beads (capture antibody, no analyte),
uncoated or BSA-blocked beads (autofluorescence), analyte standard, PE-detection antibody, unlabelled
detection antibody (rebinding blocker, Exp. 11), a PE quantitation bead kit with lot-specific PE per bead
(MESF / Quantibrite-type), 100–200 nm orange/red sub-resolution beads, a uniform fluorescent slide or dye
solution, a slide-format power meter (Thorlabs S170C-type sensor), and n-propyl gallate (antifade, optional).

---

## 1 · Instrument calibration (half a day; repeat the short versions every session)

### Exp. 1 — Laser power at the sample vs software %
- **Do:** with a slide power meter under each objective (10x and 20x), 561 nm, scanning parked or a small
  zoomed ROI, record µW at the sample for laser % = 0.1, 0.3, 1, 3, 10, 30, 100. Repeat at the start and the end of
  every quantitative session (5 points is enough then).
- **Pins:** peak irradiance I₀ = 2P/(πw₀²) and with it the excitation rate per PE, the saturation level and the
  bleaching dose per frame. The same % gives different power through 10x and 20x (back-aperture fill
  differs [Jonkman 2020]), and the % → µW map drifts.
- **Decision:** the % settings that give the operating powers below. Every later experiment is specified in
  **µW at the sample**, never in %.

| Objective | Spot waist w₀ (model) | Power for I/Iₛ ≈ 0.1 (≈10 % saturation) | Power for I/Iₛ ≈ 0.3 |
|---|---|---|---|
| 20x/0.75–0.80 | ≈0.30–0.32 µm | ≈3 µW | ≈10 µW |
| 10x/0.45 | ≈0.54 µm | ≈8 µW | ≈28 µW |

### Exp. 2 — Detector photon-transfer curve (gain, offset, read noise)
- **Do:** a uniform fluorescent sample (dye solution in a thin chamber, or a fluorescent plastic slide), 20x,
  pinhole 1 AU. At **one HV**, take **pairs** of frames at 8–10 laser powers spanning dark to near-saturation, plus
  20 dark frames (laser off). Repeat at 4–5 HV values covering the range you would ever use.
- **Analysis:** for each pair, mean m = ⟨(I₁+I₂)/2⟩ − offset and variance v = var(I₁−I₂)/2 (the difference
  removes the illumination pattern). Fit **v = g·F·m + σ_read²**.
- **Pins:** the conversion **DN → effective photoelectrons** (g·F) per HV, the offset and read noise. Real
  shot-noise SNR can then be computed for every bead [Waters 2009]. g and F cannot be separated this way; the
  product is what SNR needs.
- **Decision:** the HV at which g·F puts the brightest expected rim pixel at ≤ 60–70 % of 65,535.

### Exp. 3 — Flat field per objective and scan format
- **Do:** the uniform sample, every objective × zoom × scan size you will use, 4–8 averaged frames, slightly
  defocused or moved between frames to average out debris. Repeat every session.
- **Pins:** the vignetting map v(x, y). Corner-to-centre fall-off of ≥ 10 % is typical [Jonkman 2020].
- **Decision:** divide every bead image by the normalised flat field. Analyse only the region where the
  correction factor is < 1.25, or report the bias that remains.

---

## 2 · Optics of the shell (one session)

### Exp. 4 — PSF, plane response and axial scaling
**4a · Point response.** 100–200 nm orange beads dried on the coverslip, then covered with water. z-stacks at
0.1 µm (20x) or 0.25 µm (10x) steps over ±10 µm, at pinhole **0.5, 1, 2, 4 AU and max**, for 10x and 20x. Use
pixels ≤ 0.1 µm (20x) or 0.2 µm (10x).
→ Pins the lateral FWHM and the **on-axis** axial FWHM vs pinhole. Compare with the model table (20x 1 AU:
0.40 µm / 1.5 µm; 10x 1 AU: 0.62 µm / 4.0 µm).

**4b · Plane response H(z) — the one the integrated metric depends on.** Coat a glass-bottom well with
PE-antibody (adsorb ~1 µg/mL for 30 min, wash, cover with buffer) so a thin PE layer sits on the glass. z-scan
through it at the same objective × pinhole grid, 0.25 µm steps, at low power.
→ The mean intensity vs z **is** the plane-integrated response H(z). Its width (model 20x 1 AU: 2.6 µm;
10x 4 AU: 28 µm) sets how tolerant the integrated metric is to focus. Zeiss gives a different prefactor for a
fluorescent plane than for a point [Wilhelm, Zeiss monograph].

**4c · Axial scaling, dry lens into water.** z-stack the assay beads themselves at 20x, 1 AU, 0.2 µm steps. The
top-to-bottom shell peak distance does not depend on the PSF [Besseling 2015]. So apparent diameter in z
divided by the diameter in x/y gives the **focal scaling factor**. Expect ≈0.75, i.e. a true focal depth of
≈1.33 × nominal stage travel (paraxial n_water/n_air).
→ Pins: how far to set Perfect Focus above the glass to reach the bead equator, which is 4 µm above it
(≈3 µm nominal). Converts every z0 in the model to stage units.

### Exp. 5 — Single-bead z-series in all four modes (the core optics validation)
- **Do:** wells of assay beads at a **high** and a **mid** coverage. For ~10 beads per well, z-stacks from −8 to +8 µm
  around the equator, 0.25 µm steps, in four modes: **20x 1 AU, 20x 4 AU, 10x 1 AU, 10x max pinhole**. Use 20 px
  per bead and a low dose (3 µW at 20x, 8 µW at 10x, 1–2 µs dwell). Re-image the first plane at the end to measure
  the bleaching the stack caused (target < 2 %).
- **Measure per plane:** integrated intensity in a disk of radius R + 2.5 µm with a local annulus background,
  ring-mean, rim peak, ring radius, peak/centre contrast.
- **Pins and checks:**
  - integrated vs z0, ring metrics vs z0 and ring radius vs z0, compared with Figs 3 and 7 of the report;
  - **shell vs penetrating label, and the PSF tails.** At 20x 1 AU at the equator a volume-labelled bead gives
    peak/centre ≈ 1. A shell gives a dark centre, and how dark depends on how fast the out-of-focus response
    falls off. The explicit beam-plus-pinhole PSF in the simulator (≈1/z² tails) predicts ≈ 15. A Gaussian
    section predicts > 100. The measured value picks the tail model, which also sets the cap signal at 10x.
    Porous beads that let antibody inside give an intermediate, flatter profile;
  - the bead radius distribution, from the equatorial ring radius. Bead-size CV propagates into the integrated
    metric as σ·R·∫H for thin sections and σ·R² for thick ones.
- **Decision:** confirms or rejects the predicted focus tolerance of each mode, which picks the default
  acquisition mode.

### Exp. 6 — Position effects: sub-pixel phase, pixels per bead, field position
**6a · Sampling at equal dose.** One field of many beads imaged at **8, 12, 20, 40 px per bead** (zoom or scan
format). Scale the dwell as 1/(px per bead)² so the dose per µm² is the same in every case. The beads are
identical across conditions, so the comparison is paired. Random bead positions sample every sub-pixel
phase for free.
→ Pins the predicted swings (integrated < 0.2 % at ≥ 20 px, 2.7 % at 8 px; ring-mean 4.5 % at 20 px, 34 % at
8 px). Decides the coarsest sampling the integrated metric tolerates, which is the throughput lever.

**6b · Same beads, different field positions.** Pick 5 isolated beads. Move the stage so each is imaged at
9 positions (centre, edge midpoints, corners) with the same settings. Repeat after flat-field correction.
→ What remains after correction is field curvature, which defocuses the edge beads. The model predicts
that ring metrics suffer far more than the integrated metric.

---

## 3 · PE photophysics on this instrument (one session)

### Exp. 7 — Bleaching, saturation and the dwell-vs-averaging trade
**7a · Bleaching per frame.** For each power, **50 consecutive frames** of a *fresh* field of high-coverage
beads, fixed dwell (2 µs), 20 px per bead. 20x: 0.3, 1, 3, 10, 30 µW. 10x: 1, 3, 10, 30, 100 µW.
→ Integrated intensity per bead vs frame gives the fractional loss per frame vs dose. With I₀ from Exp. 1 that
gives the **photodestruction yield** on the beads (literature R-PE 1.1 × 10⁻⁵ per absorbed photon
[White & Stryer 1987]). The model predicts 0.29 % per frame at 10 µW, 2 µs, 0.4 µm pixels at 20x.

**7b · Reversible dark state.** In two of the 7a fields, pause 60 s after frame 25, then continue.
→ A partial recovery shows the millisecond-scale reversible dark state seen for R-PE [Gaigalas 2006]. Its size
decides whether resonant scanning with averaging, which gives a long recovery time between visits, beats a
long galvano dwell.

**7c · Linearity / saturation.** First-frame integrated intensity vs power on fresh fields, 6 powers.
→ Fit S ∝ I/(1 + I/Iₛ). Expect Iₛ ≈ 18–19 kW/cm² (B-PE optimum ≈ 5 × 10²² photons cm⁻² s⁻¹ [Mathies 1990];
the model gives 19 kW/cm² from ε and τ). **Decision:** the operating power where the deviation is < 5 %.

**7d · Same dose, three ways.** Equal total dose: (i) one frame at 8 µs, (ii) 4 averaged frames at 2 µs, (iii)
resonant with line integration to match. Compare signal per dose and bead-to-bead CV.
→ Picks the scan mode.

**7e · Antifade.** Repeat 7a at one power with n-propyl gallate in the imaging buffer.
→ The literature gives 1.7× slower R-PE photodestruction with it [White & Stryer 1987]. ROS scavengers, DTT,
ascorbate and oxygen removal did nothing there, so do not bother with them.

**7f · Focus-finding dose.** Live-scan one field for 10 s the way you would to focus, then acquire it and an
untouched neighbour field.
→ Puts a number on the cost of focusing on PE.

### Exp. 8 — Gain ladder on real beads
- **Do:** one field with a mix of bright and dim beads, the same power and dwell, 6 HV settings from low to just
  saturating.
- **Pins:** confirms with Exp. 2 that the integrated metric in photoelectron units is HV-independent until
  clipping, and that bead-to-bead CV does not improve with HV. The model says gain only maps the signal onto the
  ADC range.
- **Decision:** the single plate HV, set on the brightest standard.

---

## 4 · Backgrounds and absolute calibration (one session)

### Exp. 9 — Background sources and the real LOD floor
**9a · Free PE-antibody (sets V_eff).** Wells of blank beads in PE-antibody at **0, 0.1, 0.3, 1, 3, 10 nM**, no
wash, imaged in the four modes of Exp. 5.
→ Background per pixel vs concentration gives the effective detection volume V_eff (model 20x 1 AU 0.53 µm³,
10x 1 AU 3.7 µm³, 10x 4 AU 11 µm³) and the no-wash LOD per mode (model: ≈ 110 PE per bead at 1 nM for 20x 1 AU).
The blank beads should read **negative** after annulus subtraction, because each bead pushes the free
PE-antibody out of its own volume. The slope of that negative signal vs concentration is the excluded-volume
correction a no-wash assay must add back (≈1 PE/µm² per nM predicted).

**9b · Bead autofluorescence.** Uncoated or blocked beads in buffer, the chosen mode, ≥ 100 beads.
→ Per-bead autofluorescence in PE-equivalents (after Exp. 10). It can set the LOD before shot noise does.

**9c · Nonspecific PE binding.** Capture beads + PE-antibody, **no analyte**, through the full assay protocol:
washed, and unwashed if a no-wash format is planned. ≥ 3 wells, ≥ 100 beads each.
→ PE per bead from nonspecific binding and its bead-to-bead SD. **This, not photon noise, is the practical
LOD.** The model's detector-only LOD is ≈ 15–20 PE per bead.

### Exp. 10 — Absolute calibration to PE molecules per bead
- **Do:** the PE quantitation bead kit (4 levels plus blank) in buffer, imaged with the exact settings of the
  assay, every session, on every plate.
- **Analysis:** integrated intensity (photoelectrons) vs the lot's PE per bead → **photoelectrons per PE
  molecule**. The calibration beads differ from the assay beads in size and labelling geometry. Simulate both
  with the model (`render(BeadState(R_um=…, kind=…))`) to transfer the calibration. Alternatively use a
  z-sum acquisition for the calibration wells, which removes the geometry dependence.
- **Saturation wells:** assay beads at saturating analyte and saturating PE-antibody give the **capture-site
  distribution**: mean S_T in PE per bead and its bead-to-bead CV once optics and photon noise are subtracted.
  That CV sets how many beads per well are needed.
- **PE per detection antibody:** measure the conjugate's PE:IgG ratio (A565/A280 with the vendor's extinction
  coefficients, or the vendor's lot sheet). Commercial PE conjugates mix 0, 1 and 2 PE per IgG plus free PE, and
  this ratio converts PE per bead into analyte per bead.
- **Optional cross-check:** run the same assay beads and the same calibration kit on a flow cytometer. It gives PE
  per bead with no focus, shell geometry or field effects, which makes it the best independent check of the
  whole imaging chain.

---

## 5 · Assay kinetics and the standard curve (two to three sessions)

Every image in this section is taken with the mode chosen in Exps. 5–8, a **fixed wash-to-image time**, and fresh
fields (each field imaged once). Each time point is its own well or its own fresh field, so imaging never
bleaches a later time point.

### Exp. 11 — Rate constants
**11a · Association, one-step format.** Analyte at three concentrations (≈ 0.1×, 1× and 10× the expected
K_D1) with PE-antibody at the working D₀, sampled at 5, 15, 30, 60, 120, 240 min and overnight. Stop each by
washing.
→ Global fit of `binding.py` gives k₁ and k₂, with depletion fixed by the known bead count and volume.

**11b · Dissociation after the wash (gives k₋₂ + k₋₃).** Equilibrate one-step at a mid concentration, wash,
then image fresh fields every 5 min for 2–4 h. Run two arms: plain buffer, and buffer with **excess unlabelled
detection antibody** (≈ 100 nM).
→ PE on the bead decays as a single exponential at **k₋₂ + k₋₃**, because SA carries no PE. The unlabelled arm
blocks rebinding of released PE-antibody. If the two arms agree, rebinding is negligible and the plain-buffer
rate is intrinsic.

**11c · Delayed detection (gives k₋₁).** Two-step: capture analyte with no PE-antibody, wash, and hold in
buffer for 0, 15, 30, 60, 120, 240 min. Then add saturating PE-antibody for a fixed short time, wash, and image.
→ PE ∝ the SA left after the hold, which decays at **k₋₁**. Taking k₋₃ ≈ k₋₁ (the capture bond does not care
whether D is attached), 11b then gives **k₋₂**.
*Same-bead variant (relabel pulse):* after a one-step incubation and wash, hold for t, image one set of fields
as is (decays at k₋₂ + k₋₃), then relabel the same well with saturating PE-antibody, wash and image fresh
fields (decays at k₋₁). The ratio of the two cancels bead-to-bead site variation. If capture is nearly
irreversible (k₋₁ ≈ 3 × 10⁻⁶ s⁻¹ was reported for a PSA capture antibody [Chang 2012]), 11b alone already measures k₋₂,
and 11c only needs to set an upper bound on k₋₁.

**11d · Chase with PE-antibody present (gives k₋₃ directly).** After a one-step equilibrium, replace the
liquid with buffer containing PE-antibody at the working D₀ and no analyte. Image in the no-wash mode
(20x 1 AU).
→ SA and SAD re-equilibrate within minutes, so a fraction f = k₂D₀/(k₂D₀ + k₋₂) of the captured analyte is
labelled at any moment, and PE is lost at **f·k₋₃ + (1−f)·k₋₁**. At D₀ ≫ K_D2 that is k₋₃. Compared with 11c
(k₋₁), it tests the k₋₃ ≈ k₋₁ assumption.

**11e · Transport and settling.** One mid concentration, 2 h incubation, three arms: **static**, **orbital shaking**,
and **end-over-end rotation** that keeps beads suspended.
→ The main effect is expected from settling, not from mixing at the bead surface. Settled 8 µm beads harvest
analyte only from a thin layer above the monolayer, with a clearance time of hours for a 1.5 mm column, while
suspended beads see the whole volume. The residual difference between shaking and rotation measures
per-bead transport limitation (Damköhler number ≈ 0.05–3 for realistic site numbers and on-rates).

**11f · Bead number (depletion).** A low analyte concentration with 1,000, 5,000 and 20,000 beads in the same
volume.
→ If PE per bead falls as bead number rises, the assay depletes analyte. The standard curve then depends on
bead count, which must be held fixed.

### Exp. 12 — Standard curve and hook
- **Do:** a 12-point half-log analyte titration covering the expected range plus two points well above it,
  at **three D₀ levels** bracketing the K_D2 estimated in Exp. 11 (e.g. 0.3×, 1× and 3× K_D2), in triplicate wells.
  Use 2 h incubation, the fixed bead number, and reference wells (Exp. 10).
- **Analysis:** fit the mechanistic model globally (S_T, K_D1, K_D2, with D₀ and depletion known), and a 4PL/5PL
  for routine use. Locate the hook onset.
- **Decision:** the working D₀. The PE-coverage ceiling is S_T·D₀/(K_D2 + D₀), so D₀ ≫ K_D2 is needed to approach
  saturation, but a larger D₀ raises the no-wash background. The fit also gives the dilution rule for samples
  near the hook.

---

## 6 · Strategy validation (one session)

### Exp. 13 — Head-to-head of the candidate measurement modes
- **Do:** one standard-curve plate (Exp. 12 layout) imaged in each candidate mode:
  - **A** 10x, max pinhole, one plane, 12–20 px per bead;
  - **B** 20x, 1 AU, one plane at the equator with Perfect Focus;
  - **C** 20x, 1 AU, sum of 5 planes at 2 µm steps (±4 µm);
  - **D** 10x, 1 AU, one plane.

  Image the plate **three times on one day** and **once on each of three days**, with the reference wells.
- **Score each mode on:** LOD (3 SD of blank beads in PE per bead), CV per well, the slope of the standard curve,
  beads measured per minute, bleaching per pass, and day-to-day repeatability after calibration.
- **Decision:** the default protocol. The simulation's prediction to test: A is most focus-tolerant and fastest
  for washed assays, and B or C wins for no-wash or very low signals.

### Beads per well
Once Exp. 10 gives the capture-site CV, the beads needed for a ±1 % standard error of the well median is
N ≈ (1.25·CV/0.01)². That is ≈ 40 beads at 5 % CV and ≈ 160 at 10 %. At 10x a field usually holds hundreds.

---

## 7 · What to send back

| Per experiment | Contents |
|---|---|
| Raw images | .nd2 as acquired. Do not export to 8-bit or apply LUTs. |
| Settings | Captured in the .nd2. Add measured **µW at the sample** (Exp. 1) to the CSV. |
| Plate map CSV | `experiment, date, well, field, bead_type, analyte_M, D0_M, incubation_min, wash_to_image_min, mixing, beads_per_well, volume_uL, buffer, objective, pinhole_AU, px_per_bead, dwell_us, power_uW, HV, offset, averages, z_mode, notes` |
| Session refs | Exp. 1 power readings (start and end), Exp. 3 flat fields, Exp. 10 calibration beads |

## 8 · If there is only one day

Run **Exp. 1 → 2 (one HV) → 3 → 5 (two modes: 10x max pinhole and 20x 1 AU) → 7a (two powers) → 9c → 10**.
That pins the photon conversion, the focus tolerance of the two leading modes, the bleaching rate, the real
LOD floor and the absolute PE scale. That is enough to choose the acquisition mode before spending antibody on
kinetics.

---

### References cited above
- Jonkman J, Brown CM, Wright GD, Anderson KI, North AJ. *Tutorial: guidance for quantitative confocal microscopy.* Nat Protoc 15:1585–1611 (2020).
- Waters JC. *Accuracy and precision in quantitative fluorescence microscopy.* J Cell Biol 185:1135–1148 (2009).
- Wilhelm S, Gröbler B, Gluch M, Heinz H. *Confocal Laser Scanning Microscopy: Principles.* Carl Zeiss monograph.
- Besseling TH, Jose J, van Blaaderen A. *Methods to calibrate and scale axial distances in confocal microscopy as a function of refractive index.* J Microsc 257:142–150 (2015).
- White JC, Stryer L. *Photostability studies of phycobiliprotein fluorescent labels.* Anal Biochem 161:442–452 (1987).
- Mathies RA, Peck K, Stryer L. *Optimization of high-sensitivity fluorescence detection.* Anal Chem 62:1786–1791 (1990).
- Gaigalas A, Gallagher T, Cole KD, Singh T, Wang L, Zhang YZ. *A multistate model for the fluorescence response of R-phycoerythrin.* Photochem Photobiol 82:635–644 (2006).
- Nikon AX / AX R specifications; Nikon CFI Plan Apochromat Lambda D specifications.
- Chang L, Rissin DM, Fournier DR, Piech T, Patel PP, Wilson DH, Duffy DC. *Single molecule enzyme-linked immunosorbent assays: theoretical considerations.* J Immunol Methods 378:102–115 (2012).
