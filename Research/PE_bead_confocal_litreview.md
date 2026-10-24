# PE bead assay model — literature review

*McGhee Lab · built 2026-10-24 · the same content is laid out as a Scientia note (“PE bead assay model — lit review”) in the project “PE bead assay on the AX R confocal”, with every open PDF on the canvas. The model it tests: [PE_bead_confocal_assay_model.md](PE_bead_confocal_assay_model.md); the experiments it feeds: [PE_bead_confocal_experiments.md](PE_bead_confocal_experiments.md).*

> **Bottom line.** The binding and imaging models hold up, with three corrections from the literature. Rebinding makes the post-wash PE loss an effective rate. PE is not a two-level dye, so the ≈ 2 µW linear limit is an upper bound. A polystyrene bead in water acts as a lens and dims the far side of its own PE shell, so the bead material is the first thing to settle.

## The question

Do the assumptions our PE-bead model rests on hold up in the literature, and what does the literature change?
- **A** · Binding: a one-step sandwich on an 8 µm bead, mass action with transport, the hook, and a post-wash PE loss at k₋₂ + k₋₃.
- **B** · PE: a bright, saturable, bleachable label whose photons per molecule set the limit of detection.
- **C** · Imaging: one pinhole-set confocal plane on the AX R, read as integrated intensity, with power, detector and field calibrated.
- **D** · The bead: a fluorescent shell on a sphere that may bend light, and how to put absolute PE numbers on it.

## Verdicts

**Verdict · A binding**

The binding model holds; the wash has to be read as an effective rate.
- Transport to a sphere caps capture at 4πDR and turns rate constants into effective coefficients without moving the equilibrium, which is the form our ODEs use (Goldstein et al. 1999) (Berg & Purcell 1977) (Goldstein & Dembo 1995).
- The one-step hook is free analyte competing with the labelled complex; the large complex is transport-limited, free analyte is not (Saateh et al. 2026) (Fernando & Wilson 1992).
- Bead number × capture sites sets the capture clock (Rissin et al. 2010) (Chang et al. 2012).
- Correction: after the wash, rebinding slows the PE loss, so Exp 11 measures an effective rate, and the tail need not be exponential (Goldstein et al. 1999).

**Verdict · B PE**

The PE constants hold; the two-level picture does not.
- R-PE is bright (Q ≈ 0.8) and conjugation leaves its yield and spectrum unchanged (Oi et al. 1982); bleaching scales with photons absorbed, φ_d = 1.1 × 10⁻⁵, 1.7× better with n-propyl gallate (White & Stryer 1987).
- PE also goes dark reversibly within milliseconds and sublinear at higher power (Gaigalas et al. 2006); its survival drops fast, then slowly, and a simple model does not fit it (Doornbos et al. 1997).
- So the ≈ 2 µW threshold from our two-level model is an upper bound until Exp 7 measures linearity on beads.
- Brightness per PE on a bead may differ from solution (Gaigalas et al. 2001) (Doornbos et al. 1997).

**Verdict · C imaging**

One confocal plane is quantitative if it is calibrated, and every calibration in our plan has a precedent.
- 1 AU is the standard trade-off between section and signal (Jonkman et al. 2020).
- Measure power at the sample: % laser drifts 10–25% in 3 h, and focus drifts > 1 µm per 10 min in the first hour (Jonkman et al. 2020) (Nelson et al. 2021).
- Never clip; convert grey levels to photons with a photon-transfer line (Waters 2009) (Murray et al. 2007).
- Flat-field: beads differ by field position on a Nikon 20x/0.75 (Waters 2009).
- Axial scale from a dye-filled chamber of known height, not from bead peaks (Besseling et al. 2015).
- Caveat: bead-to-bead focus is a large noise source (Murray et al. 2007), which is why we focus at the measured stationary point.

**Verdict · D the bead**

The index-matched shell of the model is the exception, not the rule.
- Shell-stained beads are standard test objects, and their z-images stretch and can be asymmetric (Bratton & Shaevitz 2015) (Zucker et al. 2007).
- A surface-labelled polystyrene particle loses much of its far-hemisphere signal to reflection and refraction; an index-matched hydrogel particle does not (Vorselen et al. 2020) (Darafsheh 2021).
- So the bead material is the first question, and Exp 5 measures F(z₀) and its symmetry before anything else.
- No-wash confocal bead assays work (Swartzman et al. 1999); absolute PE numbers go through MESF / QuantiBRITE, with environment caveats (Wang et al. 2002) (Gaigalas et al. 2005) (Pannu et al. 2001).

## What the literature changes

What the evidence changes in the model and in the experiments.
1. **Wash, Exp 11.** Report Λ as an effective, rebinding-slowed rate: Λ ≈ k₋₂ + k₋₃/(1 + Da₃). Fit a model that allows a slower-than-exponential tail, and run two capture densities to see rebinding directly (Goldstein et al. 1999).
2. **Power, Exp 7.** Measure linearity and dark-state recovery at the real dwell, line period and frame interval. Treat 2 µW as an upper bound (Gaigalas et al. 2006) (Doornbos et al. 1997).
3. **Bead optics, Exp 5.** Ask the vendor for the bead material first. Image commercial ring-stained beads (FocalCheck) beside ours as a known shell (Bratton & Shaevitz 2015). If ours are polystyrene, expect a dim, distorted far side; quantify at the near-side stationary point, or move to index-matched capture beads (Vorselen et al. 2020).
4. **Axial scale, Exp 4c.** A dye-filled chamber of known height (Besseling et al. 2015).
5. **Calibration, Exp 10 and 13.** Flow cytometry on QuantiBRITE PE with 1:1 PE:antibody conjugates (Pannu et al. 2001); Exp 7g tests brightness per PE against density (Gaigalas et al. 2001).
6. **Hook guard, Exp 12.** Keep the 1× / 10× dilution check; capacity and D_T move the hook (Fernando & Wilson 1992). Time courses near the top of the curve show the regime change (Saateh et al. 2026).

## A · Binding and transport: does the one-step sandwich behave as our ODEs say?

**Verdict: yes, with one correction to how the wash is read.** Transport to a sphere, the bead-number clock and the one-step hook are all established. Rebinding after the wash means the measured PE loss is an effective rate, slower than k₋₂ + k₋₃, and possibly not a single exponential. Our antibody pair's rates are not in the literature and must be measured.

### Transport to the bead

Transport to a sphere caps the capture rate at 4πDR and slows binding and unbinding alike, leaving the equilibrium where it was.
- On a sphere, rate constants become effective coefficients that depend on the free receptors; the forward rate saturates at 4πDa per unit concentration, whatever the receptor density; their ratio is still the true K (Goldstein et al. 1999).
- The same physics sets how few absorbing patches make a sphere a near-perfect absorber (Berg & Purcell 1977) and the effective-rate approximation for a spherical cell (Goldstein & Dembo 1995); transport matters as much as chemistry in most surface sensors (Squires et al. 2008).
- Our model: k_D ≈ 0.9–2.6 × 10¹² M⁻¹ s⁻¹ per bead and Da ≈ 0.05–3, mixed control, largest for the analyte–PE-antibody complex.
- Verdict: supported (theory). Our transport factors are this two-compartment form.

*Goldstein et al. 1999 — The influence of transport on the kinetics of binding to surface receptors: application to cells and BIAcore*
  - p. 2: “the true rate constants are replaced by effective rate coefficients that depend on the concentration of free receptors”
  - p. 3: “The faster the diffusion and the bigger the cell, the faster a molecule in solution will find the cell.”
  - p. 3: “It is not surprising that, when the receptor density is high enough to influence dissociation, this same density will influence the forward kinetics as well.”
  - p. 3: “One effect, rebinding, occurs because a ligand that dissociates from one receptor has a non-zero probability of reacting with another receptor on the same surface instead of escaping into solution.”
  - p. 3: “This slowing of the rate of dissociation has been observed, for example, for small haptens dissociating from cell surface antibody”
  - p. 3: “At long times the concentration of bound ligand does not decay exponentially”

*Berg & Purcell 1977 — Physics of chemoreception*
  - From the abstract: a molecule that has collided with a cell finds a receptor with probability Ns/(Ns + πa) for N receptors of binding radius s on a cell of radius a; "For nearly optimum performance only a small fraction of the surface need be specifically adsorbing." (PMC1473391, not in the open-access subset.)

*Goldstein & Dembo 1995 — Approximating the effects of diffusion on reversible reactions at the cell surface: ligand-receptor kinetics*
  - From the abstract: the lowest-order approximation gives "modified chemical rate equations where, in place of fundamental rate constants, effective rate coefficients appear" — functions of the ligand diffusion coefficient, the cell radius and the receptor density. (PMC1282020, not in the open-access subset.)

*Squires et al. 2008 — Making it stick: convection, reaction and diffusion in surface-based biosensors*
  - From the abstract: "In nearly all sensors, the transport of target molecules to the sensor can play as critical a role as the chemical reaction itself in governing binding kinetics, and ultimately performance." Rules of thumb for fluxes, collection rates and equilibration times. No open PDF.

### The wash

After the wash, rebinding slows the PE loss, and the decay need not stay exponential.
- A ligand released from one receptor can bind another on the same surface, so dissociation from a crowded surface is slower than from one receptor, and it slows further as sites free up (Goldstein et al. 1999).
- The effective-rate model predicts an exponential tail; at long times the true decay is slower than exponential (Goldstein et al. 1999).
- For us: the complex route (k₋₃) rebinds to free capture sites, which are many after a low-analyte assay; the detection-antibody route (k₋₂) rebinds only to captured analyte, which is scarce. Exp 11's Λ is about k₋₂ + k₋₃/(1 + Da₃), not the intrinsic sum.
- Verdict: qualifies our model. Fit Exp 11 with rebinding, and compare two capture densities.

*Quoted from papers listed under other findings of this part:*
  - Goldstein et al. 1999, p. 3: “One effect, rebinding, occurs because a ligand that dissociates from one receptor has a non-zero probability of reacting with another receptor on the same surface instead of escaping into solution.”
  - Goldstein et al. 1999, p. 3: “This slowing of the rate of dissociation has been observed, for example, for small haptens dissociating from cell surface antibody”
  - Goldstein et al. 1999, p. 3: “At long times the concentration of bound ligand does not decay exponentially”

### The capture clock

Bead number and capture density set how fast analyte is captured; practical incubations stop short of equilibrium.
- Digital ELISA: 200,000 beads in 100 µL with ~80,000 antibodies each are ~0.3 nM of capture antibody; too many beads raise non-specific binding (Rissin et al. 2010).
- The theory behind it predicts captured complexes from reagent concentrations, times and on/off rates (Chang et al. 2012), the same bookkeeping as our model.
- Comment: Rissin argues capture is not kinetically limited because beads are ~80 µm apart. That is the diffusion time between beads, not the pseudo-first-order rate k_on × [capture sites], which in our model limits a 1 h incubation to ~35% capture at 10⁴ beads in 50 µL.
- Verdict: supported. Count beads (≤ 5% CV) and fix beads per volume; bead number is a calibration parameter.

*Rissin et al. 2010 — Single-molecule enzyme-linked immunosorbent assay detects serum proteins at subfemtomolar concentrations*
  - p. 4: “200,000 beads in 100 μL that each have about 80,000 antibodies bound to them equates to an antibody concentration of about 0.3 nM”
  - p. 4: “Kinetically, for 200,000 beads dispersed in 100 μL, the average distance between beads is about 80 μm.”
  - p. 4: “excessive bead concentrations can lead to: a) increases in non-specific binding that reduces signal-to-background”

*Chang et al. 2012 — Single molecule enzyme-linked immunosorbent assays: theoretical considerations*
  - From the abstract: equations "based on bimolecular interactions" predict the immunocomplexes formed from the reagent concentrations, interaction times and on- and off-rates; digital ELISA is efficient across antibody affinities K_D ≈ 10⁻¹¹–10⁻⁹ M, and antibodies with on-rates above 10⁵ M⁻¹ s⁻¹ are predicted to perform best; strategies for dissociation over time are described. (Author manuscript PMC3327511, not in the open-access subset.)

### The one-step hook

The one-step hook is free analyte out-competing the labelled complex, and the two routes run on different clocks.
- All components meet in solution; excess analyte blocks sandwich formation by competing with the labelled detection antibody (Saateh et al. 2026).
- Premixed large label–analyte complexes bind transport-limited; free analyte diffuses orders of magnitude faster and binds reaction-limited, which is the kinetic signature of the hook (Saateh et al. 2026).
- High-capacity solid phases push the hook to higher analyte; the labelled-antibody concentration shapes the response (Fernando & Wilson 1992).
- Our model: the fall starts near A_T ≈ max(S_T + K₁, D_T + K₂), and Da is highest for the analyte–PE-antibody complex.
- Verdict: supported. Keep the 1× / 10× dilution check.

*Saateh et al. 2026 — Kinetic Profiling in One-Step Digital Immunoassays Enables Multiplex Quantification across an Ultrabroad Dynamic Range*
  - p. 1: “In one-step sandwich immunoassays, where all binding components coexist in solution, excessive analyte levels can inhibit sandwich complex formation by competing with labeled detection antibodies, producing the well-known “hook effect.””
  - p. 5: “Since the AuNPs are relatively large and premixed with the analytes before chip application, mass transport (diffusion through the stagnant layer) remains the dominant limitation during binding.”
  - p. 5: “Because free analytes are significantly smaller than the AuNPs, they diffuse orders of magnitude faster, altering the kinetics: binding becomes reaction-limited, governed by the probability of forming stable ternary complexes on the surface rather than diffusion alone.”
  - p. 6: “this kinetic framework is broadly applicable to any surface-based one-step assay governed by competing binding equilibria, including electrochemical, field-effect-, and fluorescence-based systems”

*Fernando & Wilson 1992 — Studies of the 'hook' effect in the one-step sandwich immunoassay*
  - From the abstract: the one-step sandwich "suffers from the 'hook' effect irrespective of the analyte characteristics"; "high capacity solid-phase antibodies can effectively shift the 'hook' to relatively higher analyte concentrations"; the effect of the labelled-antibody concentration was examined theoretically. No open PDF.

### Untested: our antibody pair

Untested: the rates and site numbers of our own capture and detection antibodies.
- Bead immunoassays work across K_D ≈ 10⁻¹¹–10⁻⁹ M, best with k_on > 10⁵ M⁻¹ s⁻¹ (Chang et al. 2012): a range, not our pair.
- Exp 11 (post-wash time course, delayed detection, clamp) and Exp 10 (active sites, PE:IgG ratio) pin them.

## B · PE: is the photon budget right?

**Verdict: the constants hold; the two-level picture does not.** R-PE's absorption, yield and bleaching yield are established, and conjugation does not change them. PE also has a reversible dark state and goes sublinear with power in ways a two-level model misses, and its brightness on a surface can differ from solution. The ≈ 2 µW threshold is an upper bound to measure.

### How bright PE is

R-PE is bright, stays bright when conjugated, and also works at 488 nm.
- Very high absorbance and a quantum yield near 0.8, constant over a wide pH range; not quenched by most biomolecules; PE-avidin keeps the native yield and spectrum (Oi et al. 1982).
- At 488 nm, ε = 1.28 × 10⁶ M⁻¹ cm⁻¹ and Q = 0.82 (Oi et al. 1982), about 0.65 of our model's 1.96 × 10⁶ at the peak: the basis of the 488 nm option in Exp 7h.
- In 1982 flow cytometry, ~10³ PE per cell was the estimated detection limit (Oi et al. 1982); our model puts the washed confocal limit at ~64 PE per bead at 2 µW.
- Verdict: supported.

*Oi et al. 1982 — Fluorescent phycobiliprotein conjugates for analyses of cells and molecules*
  - p. 1: “their fluorescence is not quenched by most biomolecules”
  - p. 4: “the quantum yield and emission spectrum of the PE-avidin conjugates are virtually the same as those of native phycoerythrin”
  - p. 4: “A phycoerythrin/fluorescein intensity ratio of 10 was measured when equimolar solutions of these substances were flowed through the cell sorter”
  - p. 4: “We estimate that 10³ molecules of phycoerythrin bound to a cell could be detected in flow cytometry experiments”

### Bleaching per absorbed photon

Photodestruction depends on photons absorbed, with a fixed yield; signal is best near one absorption per fluorescence lifetime.
- R-PE: φ_d = 1.1 × 10⁻⁵, linear in laser power; 1.7× more stable with n-propyl gallate; other antioxidants and deoxygenation did nothing (White & Stryer 1987).
- Signal-to-noise peaks when the absorption rate approaches the fluorescence decay rate (5 × 10²² photons cm⁻² s⁻¹ for β-phycoerythrin) and the illumination time approaches the photodestruction time (Mathies et al. 1990).
- Our model uses both: I_sat ≈ 19 kW/cm², and ~230–350 detected photons per PE before it bleaches.
- Verdict: supported (abstracts; no open PDF).

*White & Stryer 1987 — Photostability studies of phycobiliprotein fluorescent labels*
  - From the abstract: phycobiliprotein photodestruction "was linear with the applied laser power and depended on the total number of photons absorbed per molecule"; quantum yield 1.1 × 10⁻⁵ for R-phycoerythrin; n-propyl gallate improved photostability 1.7×; superoxide dismutase, catalase, dithionite, ascorbate, DTT, EDTA or argon had no effect. No open PDF.

*Mathies et al. 1990 — Optimization of high-sensitivity fluorescence detection*
  - From the abstract: with singlet saturation and photodestruction, the signal-to-noise ratio depends on k (absorption rate / fluorescence decay rate) and τ (illumination time / photodestruction time); for β-phycoerythrin it is optimal near k ≈ τ ≈ 1 — 5 × 10²² photons cm⁻² s⁻¹ and a 700 µs transit. No open PDF.

### PE is not a two-level dye

PE goes dark reversibly within milliseconds, and sublinear at higher power, before it bleaches.
- R-PE emission is linear only at low power; a reversible collective dark state (milliseconds) and irreversible photodegradation (minutes) are proposed, and singlet-oxygen scavengers help only the second (Gaigalas et al. 2006).
- On cells, PE survival drops fast for short illumination, then slowly; a saturation + bleaching + triplet model did not fit PE (Doornbos et al. 1997).
- For us: a pixel lasts 1–2 µs, but the beam returns to a molecule on the next scan line ~4 ms later (2048 px at 2 µs), inside the dark-state time. The linear range can sit below the two-level ≈ 2 µW.
- Verdict: qualifies our model. Exp 7 measures linearity and recovery at the real dwell, line period and frame interval.

*Doornbos et al. 1997 — Experimental and model investigations of bleaching and saturation of fluorescence in flow cytometry*
  - p. 8: “fluorescence of FITC- and PE-labeled cells can be severely saturated and bleached in standard flow cytometric conditions (microsecond illumination)”
  - p. 6: “For FITC and PE, the survival parameter drops very rapidly for short illumination times and then more slowly for longer times.”
  - p. 11: “a more complex model is required for FITC and PE fluorescence”
  - p. 8: “The calculated extinction coefficient of PE is about 25% of the value found by White and Stryer”

*Gaigalas et al. 2006 — A multistate model for the fluorescence response of R-phycoerythrin*
  - From the abstract: R-PE emission at 570 nm is proportional to power only at low power; R-PE "undergoes both reversible emission cessation on a millisecond time scale attributed to transitions to a collective dark state, and irreversible photodegradation on a time scale of minutes"; dithiothreitol and n-propyl gallate protect against the second only. No open PDF.

### Brightness on a surface

Brightness per PE on a bead may not equal brightness in solution.
- Fluorophores on particles can reach self-quenching densities, and their microenvironment is uncertain (Gaigalas et al. 2001).
- On lymphocytes, the fitted PE extinction coefficient was ~25% of the solution value (Doornbos et al. 1997); for fluorescein on microspheres the absorption peak shifts and bleaching was never compared with solution (Gaigalas et al. 2005).
- Verdict: open. Exp 7g (PE-D / unlabelled-D dilution at fixed D_T) tests density-dependent brightness; absolute calibration needs an on-bead cross-check.

*Gaigalas et al. 2001 — The Development of Fluorescence Intensity Standards*
  - p. 6: “The effective concentration of fluorophores immobilized on particles can sometimes reach levels where self-quenching becomes significant.”
  - p. 7: “A major complication is the uncertain microenvironment of the fluorophore since it may be inside the microbead or bound close to the surface of the microbead.”

*Quoted from papers listed under other findings of this part:*
  - Doornbos et al. 1997, p. 8: “The calculated extinction coefficient of PE is about 25% of the value found by White and Stryer”

## C · Imaging: is one pinhole-set plane on the AX R quantitative?

**Verdict: yes, with a known list of calibrations.** The quantitative-confocal literature asks for what our plan does: 1 AU, power measured at the sample, no clipped pixels, photon-transfer gain, flat-field correction, warm-up, and an axial scale from a sample of known thickness. One caveat matters for us: focus differences between beads are a large noise source.

### The pinhole

1 AU is the standard compromise between section thickness and signal.
- Start at 1 AU, a good balance between optical section thickness and SNR (Jonkman et al. 2020).
- Our model: at 20x/0.75–0.80, 1 AU gives a 2.3–3.2 µm section, thinner than the bead, so F has a focus plateau; 10x cannot section below ~4.6 µm.
- Verdict: supported.

*Jonkman et al. 2020 — Tutorial: guidance for quantitative confocal microscopy*
  - p. 18: “start with setting the pinhole diameter to 1 Airy Unit (AU), which is typically a good balance between optical section thickness and signal-to-noise ratio (SNR)”
  - p. 4: “Particularly troubling are laser power fluctuations that can alter the intensity by 10% to 25% over a typical 3-hour imaging session!”
  - p. 21: “we implore the manufacturers to abandon the uncalibrated illumination unit of percent-laser-power, and instead provide a real-world unit of power (mW)”
  - p. 33: “within the first hour of powering on the microscope stand, the built-in focus drifts by more than 1 μm every 10 minutes”
  - p. 18: “If any type of quantification is to be performed, it is imperative to avoid any “clipping” of either the brightest or weakest pixels.”
  - p. 20: “Most CLSMs have at least a 10% variation in their illumination (corner to center).”

### Power and drift

Set power in measured units, warm up, and expect drift.
- Laser power can drift 10–25% over a 3 h session; % laser power is uncalibrated and should give way to mW (Jonkman et al. 2020).
- Comparing intensities between images requires the measured illumination power and its stability (Nelson et al. 2021).
- Focus drifts > 1 µm per 10 min in the first hour after the stand is switched on (Jonkman et al. 2020).
- Verdict: supported. Exp 1 (µW at the sample), a 2–3 h warm-up and a reference well at the start and end already cover it.

*Nelson et al. 2021 — QUAREP-LiMi: A community-driven initiative to establish guidelines for quality assessment and reproducibility for instruments and images in light microscopy*
  - p. 8: “illumination power—Comparison of fluorescence intensities between images requires measurements of the illumination power and stability of the excitation light source.”
  - p. 9: “If the illumination is not constant over a large area, the fluorescence intensities will not represent the inherent fluorescence but rather the location within the image.”

*Quoted from papers listed under other findings of this part:*
  - Jonkman et al. 2020, p. 4: “Particularly troubling are laser power fluctuations that can alter the intensity by 10% to 25% over a typical 3-hour imaging session!”
  - Jonkman et al. 2020, p. 21: “we implore the manufacturers to abandon the uncalibrated illumination unit of percent-laser-power, and instead provide a real-world unit of power (mW)”
  - Jonkman et al. 2020, p. 33: “within the first hour of powering on the microscope stand, the built-in focus drifts by more than 1 μm every 10 minutes”

### The detector

Never clip, and convert grey levels to photons.
- Saturated pixels stop counting photons, and cropping them out biases toward dim objects (Waters 2009); avoid clipping at either end (Jonkman et al. 2020).
- Precision grows with the photons collected (Waters 2009).
- The variance-versus-mean (photon-transfer) line gives grey levels per photon; for PMTs it changes with voltage and dwell (Murray et al. 2007).
- Verdict: supported. Exp 2 (photon transfer); HV set on the brightest standard at 70–80% of full scale; never drop saturated beads.

*Quoted from papers listed under other findings of this part:*
  - Jonkman et al. 2020, p. 18: “If any type of quantification is to be performed, it is imperative to avoid any “clipping” of either the brightest or weakest pixels.”
  - Waters 2009, p. 4: “Detectors have a limited capacity to hold electrons; if this capacity is reached, the corresponding pixel will be “saturated” and any photons reaching the detector after saturation will not be counted.”
  - Waters 2009, p. 4: “Choosing to “crop out” saturated areas is not acceptable (unless they can be shown to be irrelevant to the experimental hypothesis) because it will select for the weaker intensity parts of the specimen.”
  - Waters 2009, p. 2: “Working to increase the number of signal photons collected will therefore increase the accuracy and precision of quantitative measurements.”
  - Murray et al. 2007, p. 5: “Repeating this paired acquisition with several different illumination conditions and plotting the variances so obtained against the mean intensity value in each pair gives a straight line whose slope is 2/g.”

### The field

Illumination is uneven across the field, enough to matter for bead-to-bead comparison.
- Most CLSMs vary by at least 10% corner to centre, and 40–60% at low zoom with a wide-field objective (Jonkman et al. 2020).
- Beads with the same dye load differ by position on a Nikon TE2000E with a Plan-Apo 20x/0.75; dividing by a uniform-dye image corrects it (Waters 2009).
- Without it, intensities report position, not fluorescence (Nelson et al. 2021).
- Verdict: supported. Exp 3 flat field; use the central region if the correction is noisy.

*Waters 2009 — Accuracy and precision in quantitative fluorescence microscopy*
  - p. 4: “Detectors have a limited capacity to hold electrons; if this capacity is reached, the corresponding pixel will be “saturated” and any photons reaching the detector after saturation will not be counted.”
  - p. 4: “Choosing to “crop out” saturated areas is not acceptable (unless they can be shown to be irrelevant to the experimental hypothesis) because it will select for the weaker intensity parts of the specimen.”
  - p. 2: “Working to increase the number of signal photons collected will therefore increase the accuracy and precision of quantitative measurements.”
  - p. 8: “All images were collected using a microscope (model TE2000E; Nikon), a Plan-Apochromat 20x 0.75 NA objective lens”
  - p. 8: “Note that beads in the top left have different intensity values than the beads in the bottom right.”
  - p. 8: “This nonuniform illumination explains the nonuniform fluorescence from the beads of similar fluorophore concentration shown in A.”

*Quoted from papers listed under other findings of this part:*
  - Jonkman et al. 2020, p. 20: “Most CLSMs have at least a 10% variation in their illumination (corner to center).”
  - Nelson et al. 2021, p. 9: “If the illumination is not constant over a large area, the fluorescence intensities will not represent the inherent fluorescence but rather the location within the image.”

### One section per bead

One confocal section holds a subresolution bead's whole signal; with many beads, focus scatter dominates.
- For subresolution beads, a single in-focus section contains everything needed for the net integrated intensity (Murray et al. 2007).
- Focus differences between beads across the field were a large noise source, so the authors switched to 3–5-plane stacks (Murray et al. 2007).
- Dye in solution adds out-of-focus background, measured per bead as B/S (Murray et al. 2007): the analogue of our no-wash background.
- Verdict: qualifies our model. Our beads are 8 µm: one plane works at the measured stationary point of F(z₀), where focus scatter costs least (0.5–1.5% per µm at 20x for an index-matched bead).

*Murray et al. 2007 — Evaluating performance in three-dimensional fluorescence microscopy*
  - p. 5: “Repeating this paired acquisition with several different illumination conditions and plotting the variances so obtained against the mean intensity value in each pair gives a straight line whose slope is 2/g.”
  - p. 5: “Removal of out of focus background is accomplished automatically in a confocal when the light passes through the pinhole, so a single optical section of an in-focus bead contains all the information necessary for calculating net integrated bead intensity.”
  - p. 4: “it was found that variations in focus between different beads across the field of view was a large source of noise”
  - p. 6: “The ratio of background intensity from out of focus fluorescence to the net integrated intensity from a single bead (B/S), at various concentrations of Alexa Fluor 488 in the background solution.”

### The axial scale

Axial distances are not stage distances, and micron beads are a poor ruler.
- Axial scaling depends almost linearly on the sample's refractive index; a dye-filled cell of known height measures it (Besseling et al. 2015).
- Even a nearly index-matched micron sphere looks elongated because of the PSF; PSF width and focal shift are hard to separate with micron particles and led to overestimates (Besseling et al. 2015).
- Verdict: supported. Exp 4c uses a chamber of known height, not bead peaks.

*Besseling et al. 2015 — Methods to calibrate and scale axial distances in confocal microscopy as a function of refractive index*
  - p. 2: “We filled the cell with four different solvents mixed with fluorescent dye, which enabled the determination of the axial scaling factors as a function of RI”
  - p. 1: “a nearly index-matched, micron-sized spherical object is still significantly elongated due to this PSF, which signifies that care has to be taken when determining axial calibration or axial scaling using such particles”
  - p. 8: “These two effects are hard to separate for micron-sized particles and has led to overestimation of axial distance scaling in previous studies”

## D · The bead: a fluorescent shell on a sphere that bends light

**Verdict: the index-matched shell of the model is the exception.** Shell-stained beads are standard test objects whose z-images stretch and turn asymmetric. A polystyrene particle with a surface label loses much of its far-side signal; an index-matched particle does not. No-wash confocal bead assays and equivalent-fluorophore calibration both have precedent, with environment caveats.

### Shell beads as test objects

Shell-stained beads are a standard optical test object, and their z-images are stretched and can be asymmetric.
- FocalCheck beads carry dye only in a thin shell; their xz slices look extremely extended along z from focal shift, and top and bottom can differ in intensity, "an asymmetric diamond ring" (Bratton & Shaevitz 2015).
- FocalCheck spectral beads with ring-core dye layouts are used to test confocal systems (Zucker et al. 2007).
- For us: commercial ring-stained beads of known size are a ready optics control beside our capture beads in Exp 5.
- Verdict: supported.

*Bratton & Shaevitz 2015 — Simple Experimental Methods for Determining the Apparent Focal Shift in a Microscope System*
  - p. 5: “These microspheres have fluorescent dye only in a thin shell at the surface of the sphere (Molecular Probes 1.0 μm FocalCheck beads, F14791).”
  - p. 5: “Even though the beads are quite spherical, these slices appear extremely extended along the z dimension due to the focal shift of the system.”
  - p. 10: “Sometimes the difference in intensity at the top and bottom of an xz cross-section gives the bead an appearance of an asymmetric diamond ring.”
  - p. 1: “When the mounting media has a higher refractive index than the objective, for example when using a water-immersion objective lens with a sample mounted in plastic, the focal shift F has the same sign as Δz and the effective focal plane is moved more than the anticipated amount.”

*Zucker et al. 2007 — Reliability of confocal microscopy spectral imaging systems: use of multispectral beads*
  - From the abstract: FocalCheck spectral beads were imaged on five confocal spectral systems; the position of the PMT slider "affected the measurement of all bead intensities"; dyes "located on individual beads or mixed together in ring-core configuration can be used as test particles". No open PDF.

### The bead bends light

A polystyrene bead in water acts as a lens: the far side of a surface label is dimmed and distorted.
- Distortion grows with the index difference between particle and medium; that difference is ~100× larger for glass or polystyrene than for an index-matched hydrogel particle (Vorselen et al. 2020).
- On surface-labelled PS particles, the far (upper) hemisphere looks elongated and uneven, and its signal is largely reflected away; the authors measured on the near hemisphere only (Vorselen et al. 2020).
- Spheres much larger than the wavelength focus light by geometric optics (Darafsheh 2021). Next to a latex sphere's focus, a molecule saw 2.2× more excitation and 60% more collection (Darafsheh 2021): the bead can raise as well as lower the signal.
- Our ray trace: PS in water gives ≈ 0.6–0.75 of the index-matched signal at 20x, asymmetric in z, and the sign flips at 10x.
- Verdict: contradicts the index-matched assumption and confirms open question 1.

*Vorselen et al. 2020 — Microparticle traction force microscopy reveals subcellular force exertion patterns in immune cell-target interactions*
  - p. 2: “Optical distortions, i.e., the reflection and refraction of light, caused by a particle depends on RImedium–RIMP.”
  - p. 3: “Axial slices of the volume of PS particles, however, showed a distorted shape (the upper hemisphere appears axially elongated by ~RImedium/RIMP) and an inhomogeneous signal.”
  - p. 3: “Furthermore, the fluorescent signal from the upper hemisphere’s surface is reflected off the PS-particle surface and is largely not captured on the camera.”
  - p. 3: “Such lensing effects are barely noticeable for DAAM-particles.”
  - p. 13: “This approach, were only the lower hemisphere is used, prevents these measurements to be affected by the lensing effect caused by the particle”

*Darafsheh 2021 — Photonic nanojets and their applications*
  - p. 4: “The focusing effects in large spheres (r ≫λ) can be well approximated by the laws of geometrical optics”
  - p. 2: “PNJs are narrow intense electromagnetic beams emerging from the ‘shadow-side’ surface of a plane-wave-illuminated dielectric microcylinder or microsphere”
  - p. 14: “The excitation intensity sensed by the fluorescent molecule was increased by a factor of ∼2.2 and the collection efficiency was increased ∼60%.”

### No-wash bead assays

Reading beads without a wash works when the instrument looks only at the bead.
- FMAT's laser scanner imaged bead-bound fluorescence and ignored the unbound background; the no-wash assays matched ELISA range and sensitivity with 100× less primary antibody (Swartzman et al. 1999).
- Background from dye in solution can be measured per bead as B/S (Murray et al. 2007).
- Our model: the per-bead limit rises from ~64 PE washed to 91, 214 and 649 PE at 0.1, 1 and 10 nM free PE-antibody (20x, 2 µW).
- Verdict: supported. The no-wash read stays the fallback if Λ ≳ 10⁻³ s⁻¹.

*Swartzman et al. 1999 — A homogeneous and multiplexed immunoassay for high-throughput screening using fluorometric microvolume assay technology*
  - From the abstract: the FMAT scanner images bead-bound fluorescence "while the background fluorescence is ignored. Consequently, no wash steps are required"; the no-wash FLISA was comparable to ELISA in linear dynamic range and sensitivity and used 100-fold less primary antibody (IL-6, IL-8 in 96- and 384-well plates). No open PDF; the instrument paper (Miraglia et al. 1999, J Biomol Screen) is also closed.

### Absolute PE per bead

Absolute numbers go through equivalent-fluorophore standards, which assume the bead and the solution behave alike.
- MESF equates a labelled-bead suspension with a fluorophore solution of equal integrated emission (Wang et al. 2002).
- That hides unmeasured differences: absorption maxima shift between solution and microsphere surface, and photodegradation in the two was never compared (Gaigalas et al. 2005).
- QuantiBRITE PE beads with 1:1 PE:antibody conjugates give antibodies bound per cell with < 5% CV across cytometers (Pannu et al. 2001).
- Verdict: qualifies our model. Calibrate with the solution-PE reference and the measured T, then cross-check by flow cytometry on QuantiBRITE PE (Exp 10 and 13).

*Wang et al. 2002 — Quantitating Fluorescence Intensity From Fluorophores: Practical Use of MESF Values*
  - p. 2: “The MESF approach relies on the equivalency between the number of fluorophores in two solutions, where one solution may be a suspension of labeled microbeads.”
  - p. 2: “The MESF value of the bead suspension is the ratio between the number of fluorophores in solution and the number of beads in suspension.”

*Gaigalas et al. 2005 — Quantitating Fluorescence Intensity From Fluorophore: Assignment of MESF Values*
  - p. 11: “It is known that there are differences in the wavelength of maximum absorption between fluorescein in solution and on the surface of the microsphere.”
  - p. 11: “Systematic measurements of photodegradation in the two environments are not available.”

*Pannu et al. 2001 — Performance evaluation of QuantiBRITE phycoerythrin beads*
  - From the abstract: with QuantiBRITE PE beads "in conjunction with 1:1 conjugates of PE-to-monoclonal antibody", CD4 antibodies bound per cell had a within-assay CV < 1.0% and < 5.0% across cytometers. No open PDF.

### Untested: emission at the bead surface

Untested: how much a PE molecule ~10 nm from a polystyrene surface changes its emission pattern and the fraction the objective collects.
- The classic theory (Lukosz & Kunz 1977; Chew 1988) is not open, and no open measurement on beads was found.
- Cheapest test: the same PE-antibody on index-matched and polystyrene beads of equal size, at the same settings (the Exp 5 controls).

## Still open

What this review could not settle.
- Our antibody pair: k_on, k₋₁, k₋₂, active capture sites and non-specific binding. No literature value applies; Exp 10 and 11 measure them.
- Emission near the bead surface: how much a PE molecule ~10 nm from polystyrene changes its emission pattern and collected fraction. The classic theory (Lukosz & Kunz 1977; Chew 1988) is not open, and no open measurement on beads was found.
- Constants used with a secondary source only: the R-PE lifetime (2.5 vs 2.7 ns), ε at 561 nm for a conjugate on a bead, the diffusion coefficients of R-PE and R-PE–IgG, GaAsP QE curves, the random-sequential-adsorption limit (0.547). Each carries about ±30%.
- No open PDF (cards with the abstract's key line): Chang 2012, Berg & Purcell 1977, Goldstein & Dembo 1995, Squires 2008, Fernando & Wilson 1992, White & Stryer 1987, Mathies 1990, Gaigalas 2006, Zucker 2007, Swartzman 1999, Pannu 2001. Add the PDFs in RM's library (Find PDF / Upload). Rodbard & Feldman 1978 has no indexed abstract.
- Web sources, not papers: the Nikon AX / AX R specifications and the Lambda D objective table; the Zeiss confocal principles monograph.

## How this review was built

**Built from the model's own assumptions.**
- Each column is one part of the model; each finding says what the literature does to it: supported, qualified, contradicted or open.
- Sources: the 15 references of the PE-bead report, plus open sources found for the gaps it listed (shell beads, bead optics, PE photophysics, no-wash bead assays, calibration standards).
- Every quote was matched word for word on its PDF page. Preprints, author manuscripts and drafts are labelled on the PDF card. The Jonkman 2020 PDF is the authors' pre-publication draft from the A*STAR repository, text pages only.
- Only open routes were used (PMC open data, OpenAlex, institutional repositories, author pages). Papers behind a publisher wall are cards with the abstract's key line.
- Method: CodeLog/Feature requests/FuturePlan_14_literature_review_method.md

## References (27)

- **Berg & Purcell 1977** — Berg HC, Purcell EM. Physics of chemoreception. *Biophys J 1977;20(2):193-219*. doi:[10.1016/s0006-3495(77)85544-6](https://doi.org/10.1016/s0006-3495(77)85544-6) · PMID 911982 · no open PDF; add it in RM (Find PDF / Upload)
- **Besseling et al. 2015** — Besseling TH, Jose J, Van Blaaderen A. Methods to calibrate and scale axial distances in confocal microscopy as a function of refractive index. *J Microsc 2015;257(2):142-150*. doi:[10.1111/jmi.12194](https://doi.org/10.1111/jmi.12194) · PMID 25444358 · open PDF on the canvas
- **Bratton & Shaevitz 2015** — Bratton BP, Shaevitz JW. Simple Experimental Methods for Determining the Apparent Focal Shift in a Microscope System. *PLoS One 2015;10(8):e0134616*. doi:[10.1371/journal.pone.0134616](https://doi.org/10.1371/journal.pone.0134616) · PMID 26270960 · open PDF on the canvas
- **Chang et al. 2012** — Chang L, Rissin DM, Fournier DR, Piech T, Patel PP, Wilson DH, et al. Single molecule enzyme-linked immunosorbent assays: theoretical considerations. *J Immunol Methods 2012;378(1-2):102-115*. doi:[10.1016/j.jim.2012.02.011](https://doi.org/10.1016/j.jim.2012.02.011) · PMID 22370429 · no open PDF; add it in RM (Find PDF / Upload)
- **Darafsheh 2021** — Darafsheh A. Photonic nanojets and their applications. *J Phys Photonics 2021;3(2):022001*. doi:[10.1088/2515-7647/abdb05](https://doi.org/10.1088/2515-7647/abdb05) · open PDF on the canvas
- **Doornbos et al. 1997** — Doornbos RM, de Grooth BG, Greve J. Experimental and model investigations of bleaching and saturation of fluorescence in flow cytometry. *Cytometry 1997;29(3):204-214*. doi:[10.1002/(sici)1097-0320(19971101)29:3<204::aid-cyto3>3.0.co;2-b](https://doi.org/10.1002/(sici)1097-0320(19971101)29:3<204::aid-cyto3>3.0.co;2-b) · PMID 9389437 · open PDF on the canvas
- **Fernando & Wilson 1992** — Fernando SA, Wilson GS. Studies of the 'hook' effect in the one-step sandwich immunoassay. *J Immunol Methods 1992;151(1-2):47-66*. doi:[10.1016/0022-1759(92)90104-2](https://doi.org/10.1016/0022-1759(92)90104-2) · PMID 1378475 · no open PDF; add it in RM (Find PDF / Upload)
- **Gaigalas et al. 2001** — Gaigalas AK, Li L, Henderson O, Vogt R, Barr J, Marti G, et al. The Development of Fluorescence Intensity Standards. *J Res Natl Inst Stand Technol 2001;106(2):381-389*. doi:[10.6028/jres.106.015](https://doi.org/10.6028/jres.106.015) · PMID 27500028 · open PDF on the canvas
- **Gaigalas et al. 2005** — Gaigalas AK, Wang L, Schwartz A, Marti GE, Vogt RF. Quantitating Fluorescence Intensity From Fluorophore: Assignment of MESF Values. *J Res Natl Inst Stand Technol 2005;110(2):101-114*. doi:[10.6028/jres.110.010](https://doi.org/10.6028/jres.110.010) · PMID 27308107 · open PDF on the canvas
- **Gaigalas et al. 2006** — Gaigalas A, Gallagher T, Cole KD, Singh T, Wang L, Zhang YZ. A multistate model for the fluorescence response of R-phycoerythrin. *Photochem Photobiol 2006;82(3):635-644*. doi:[10.1562/2005-05-26-ra-544](https://doi.org/10.1562/2005-05-26-ra-544) · PMID 16420100 · no open PDF; add it in RM (Find PDF / Upload)
- **Goldstein & Dembo 1995** — Goldstein B, Dembo M. Approximating the effects of diffusion on reversible reactions at the cell surface: ligand-receptor kinetics. *Biophys J 1995;68(4):1222-1230*. doi:[10.1016/s0006-3495(95)80298-5](https://doi.org/10.1016/s0006-3495(95)80298-5) · PMID 7787014 · no open PDF; add it in RM (Find PDF / Upload)
- **Goldstein et al. 1999** — Goldstein B, Coombs D, He X, Pineda AR, Wofsy C. The influence of transport on the kinetics of binding to surface receptors: application to cells and BIAcore. *J Mol Recognit 1999;12(5):293-299*. doi:[10.1002/(sici)1099-1352(199909/10)12:5<293::aid-jmr472>3.0.co;2-m](https://doi.org/10.1002/(sici)1099-1352(199909/10)12:5<293::aid-jmr472>3.0.co;2-m) · PMID 10556877 · open PDF on the canvas (author-hosted)
- **Jonkman et al. 2020** — Jonkman J, Brown CM, Wright GD, Anderson KI, North AJ. Tutorial: guidance for quantitative confocal microscopy. *Nat Protoc 2020;15(5):1585-1611*. doi:[10.1038/s41596-020-0313-9](https://doi.org/10.1038/s41596-020-0313-9) · PMID 32235926 · open PDF on the canvas (author draft, text pages)
- **Mathies et al. 1990** — Mathies RA, Peck K, Stryer L. Optimization of high-sensitivity fluorescence detection. *Anal Chem 1990;62(17):1786-1791*. doi:[10.1021/ac00216a012](https://doi.org/10.1021/ac00216a012) · PMID 2240569 · no open PDF; add it in RM (Find PDF / Upload)
- **Murray et al. 2007** — Murray JM, Appleton PL, Swedlow JR, Waters JC. Evaluating performance in three-dimensional fluorescence microscopy. *J Microsc 2007;228(Pt 3):390-405*. doi:[10.1111/j.1365-2818.2007.01861.x](https://doi.org/10.1111/j.1365-2818.2007.01861.x) · PMID 18045334 · open PDF on the canvas
- **Nelson et al. 2021** — Nelson G, Boehm U, Bagley S, Bajcsy P, Bischof J, Brown CM, et al. QUAREP-LiMi: A community-driven initiative to establish guidelines for quality assessment and reproducibility for instruments and images in light microscopy. *J Microsc 2021;284(1):56-73*. doi:[10.1111/jmi.13041](https://doi.org/10.1111/jmi.13041) · PMID 34214188 · open PDF on the canvas (author manuscript)
- **Oi et al. 1982** — Oi VT, Glazer AN, Stryer L. Fluorescent phycobiliprotein conjugates for analyses of cells and molecules. *J Cell Biol 1982;93(3):981-986*. doi:[10.1083/jcb.93.3.981](https://doi.org/10.1083/jcb.93.3.981) · PMID 6749865 · open PDF on the canvas
- **Pannu et al. 2001** — Pannu KK, Joe ET, Iyer SB. Performance evaluation of QuantiBRITE phycoerythrin beads. *Cytometry 2001;45(4):250-258*. doi:[10.1002/1097-0320(20011201)45:4<250::aid-cyto10021>3.0.co;2-t](https://doi.org/10.1002/1097-0320(20011201)45:4<250::aid-cyto10021>3.0.co;2-t) · PMID 11746094 · no open PDF; add it in RM (Find PDF / Upload)
- **Rissin et al. 2010** — Rissin DM, Kan CW, Campbell TG, Howes SC, Fournier DR, Song L, et al. Single-molecule enzyme-linked immunosorbent assay detects serum proteins at subfemtomolar concentrations. *Nat Biotechnol 2010;28(6):595-599*. doi:[10.1038/nbt.1641](https://doi.org/10.1038/nbt.1641) · PMID 20495550 · open PDF on the canvas (author manuscript)
- **Saateh et al. 2026** — Saateh A, Allamehnejad R, Yang W, Liu YC, Tolstonog GV, Altug H. Kinetic Profiling in One-Step Digital Immunoassays Enables Multiplex Quantification across an Ultrabroad Dynamic Range. *J Am Chem Soc 2026;148(5):5253-5263*. doi:[10.1021/jacs.5c17838](https://doi.org/10.1021/jacs.5c17838) · PMID 41592440 · open PDF on the canvas
- **Squires et al. 2008** — Squires TM, Messinger RJ, Manalis SR. Making it stick: convection, reaction and diffusion in surface-based biosensors. *Nat Biotechnol 2008;26(4):417-426*. doi:[10.1038/nbt1388](https://doi.org/10.1038/nbt1388) · PMID 18392027 · no open PDF; add it in RM (Find PDF / Upload)
- **Swartzman et al. 1999** — Swartzman EE, Miraglia SJ, Mellentin-Michelotti J, Evangelista L, Yuan PM. A homogeneous and multiplexed immunoassay for high-throughput screening using fluorometric microvolume assay technology. *Anal Biochem 1999;271(2):143-151*. doi:[10.1006/abio.1999.4128](https://doi.org/10.1006/abio.1999.4128) · PMID 10419629 · no open PDF; add it in RM (Find PDF / Upload)
- **Vorselen et al. 2020** — Vorselen D, Wang Y, de Jesus MM, Shah PK, Footer MJ, Huse M, et al. Microparticle traction force microscopy reveals subcellular force exertion patterns in immune cell-target interactions. *Nat Commun 2020;11(1):20*. doi:[10.1038/s41467-019-13804-z](https://doi.org/10.1038/s41467-019-13804-z) · PMID 31911639 · open PDF on the canvas
- **Wang et al. 2002** — Wang L, Gaigalas AK, Abbasi F, Marti GE, Vogt RF, Schwartz A. Quantitating Fluorescence Intensity From Fluorophores: Practical Use of MESF Values. *J Res Natl Inst Stand Technol 2002;107(4):339-353*. doi:[10.6028/jres.107.027](https://doi.org/10.6028/jres.107.027) · PMID 27446735 · open PDF on the canvas
- **Waters 2009** — Waters JC. Accuracy and precision in quantitative fluorescence microscopy. *J Cell Biol 2009;185(7):1135-1148*. doi:[10.1083/jcb.200903097](https://doi.org/10.1083/jcb.200903097) · PMID 19564400 · open PDF on the canvas
- **White & Stryer 1987** — White JC, Stryer L. Photostability studies of phycobiliprotein fluorescent labels. *Anal Biochem 1987;161(2):442-452*. doi:[10.1016/0003-2697(87)90473-8](https://doi.org/10.1016/0003-2697(87)90473-8) · PMID 3578804 · no open PDF; add it in RM (Find PDF / Upload)
- **Zucker et al. 2007** — Zucker RM, Rigby P, Clements I, Salmon W, Chua M. Reliability of confocal microscopy spectral imaging systems: use of multispectral beads. *Cytometry A 2007;71(3):174-189*. doi:[10.1002/cyto.a.20371](https://doi.org/10.1002/cyto.a.20371) · PMID 17266146 · no open PDF; add it in RM (Find PDF / Upload)

---
27 papers · 16 open PDFs · 60 verbatim quotes, each matched word for word on its PDF page (page numbers are the PDF's own; author-manuscript and draft pages differ from the journal's).
