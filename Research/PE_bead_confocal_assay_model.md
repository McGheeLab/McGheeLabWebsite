# PE-labelled 8 µm sandwich beads on a Nikon AX-R: binding model, image model for a fluorescent shell, simulation plan and measurement strategy

*McGhee Lab deep-research report, October 2026 (revision 2).*

> **Update 2026-10-26 (V3.923).** The lab has **no laser power meter**, and the **Quantum R-PE MESF beads are the calibration beads of the ELISA bead standard**. Exp 1 is now *Laser power from the MESF beads*: a laser-% ladder on the MESF levels gives PE's linearity limit, the signal per MESF per %, and (with Exp 2 and the simulator's photon budget) a µW-equivalent for each %; every µW in this document means that µW-equivalent. Exp 10 is now *MESF calibration of the bead standard*: each plate's MESF wells turn signal into MESF per bead, Exp 12 reports the standard curve in MESF per bead, and flow cytometry is a cross-check. The protocols in [bead_confocal_protocols/](bead_confocal_protocols/README.md) and the Scientia note are current; the text below is the 24 Oct version.

**Conventions.**
- Citations are [S1]–[S15], listed at the end.
- **Derived** marks this report's own calculation from cited formulas.
- **Assumption** marks a value that is not in the cited sources and has to be measured.
- **Textbook** marks standard physics or literature values that are not among the cited sources. Part E lists the ones that still need a primary citation.

**Where the work lives** (paths relative to this file).
- **Experiments for the real system:** [PE_bead_confocal_experiments.md](PE_bead_confocal_experiments.md) (Exp. 1–13), and the same 13 as
  runnable RM protocols with live calculators and a plate builder: [bead_confocal_protocols/](bead_confocal_protocols/README.md).
- **Simulator:** [bead_confocal_sim/](bead_confocal_sim/) — `binding.py`, `optics.py`, `run_figures.py`, `figures/tables.md`, figures
  `fig1`–`fig9`; Appendix S below summarises its results.
- **This report's own calculation scripts:** [bead_confocal_sim/report_calcs/](bead_confocal_sim/report_calcs/) — first pass `partA.py`,
  `shell.py`, `tab.py`, `samp.py`, `budget.py`; this revision `tails.py` (PSF-tail dependence), `peaks.py` / `peaks2.py` (rim peak vs
  defocus), `lod.py` (limit of detection at 2 µW), `dt.py` (choice of detection-antibody concentration), `ray.py` / `ray2.py` (ray trace
  through the bead). §C.3 lists the simulator updates still to make.

**Three PSF models are used for $w(z)$, the optical-section weight.** Where a number depends on the tails of $w$, it is given as a range across all three.

| Label | Model | Status |
|---|---|---|
| **G** | Gaussian | the optimistic limit, with short tails |
| **R** | Repo wave-optical model: Gaussian beam × pinhole pass, tail ∝ 1/z² | the default, physically shaped |
| **L** | Lorentzian with the same FWHM | the heavy-tail limit |

---

## Executive summary

- **Binding model (Part A).**
  - **What is modelled.** A one-step sandwich on an 8 µm bead: capture of analyte, labelling on the surface, capture of solution pre-complexes, and pre-complexing in solution. The ODEs use mass action with finite sites, finite volume and a transport correction.
  - **Factorisation.** If the capture and detection epitopes are independent ($K_2=K_4$, $K_3=K_1$), the PE-bearing fraction of sites factors exactly as $\theta_{PE}=\theta_{cap}\cdot g$. Equilibrium then does not depend on the route by which PE arrives.
  - **Equilibrium** reduces to two decoupled quadratics, one for capture depletion and one for label depletion. The one-step **hook** follows from conservation of the detection antibody.
  - **Transport.** An 8 µm bead is in mixed transport/reaction control (Damköhler number ≈ 0.05–3).
  - **After the wash,** PE decays as a single exponential at $k_{-2}+k_{-3}$. The analyte and detection-antibody off-rates **cannot be separated from PE data alone**; a relabel-pulse or detection-antibody-clamp experiment is needed (§A.4).
  - **Choice of detection antibody.** The model sets $D_T$, the detection-antibody concentration. The default is $D_T\approx1$–$2\,K_2$ (§A.2.5).
- **Image model (Part B).**
  - **Projection.** A thin shell projects as $P(\rho)=\sigma_sR/\sqrt{R^2-\rho^2}\,[w(z_0-\sqrt{R^2-\rho^2})+w(z_0+\sqrt{R^2-\rho^2})]$, which is then blurred laterally.
  - **Appearance.** The image is a ring about 5–6× brighter than a flat sheet of the same density, and it stays pinned near R as focus changes.
  - **Integrated intensity.** For an **index-matched, non-absorbing** bead, Archimedes' theorem gives the integrated intensity exactly as $F=2\pi R\sigma_s\int_{-R}^{R}w$. This is flat with focus when the optical section is thinner than the bead (20x).
  - **New in this revision: a real bead is not index-matched, and that can break the flat-focus result.** A geometric ray trace (derived) puts polystyrene (n ≈ 1.59), PMMA and silica beads in water at about 0.6–0.75 of the index-matched equatorial signal, with a focus response that is asymmetric about the equator. For any bead that is not index-matched, the plateau has to be measured before it is relied on (§B.1.4, Exp. 5).
- **Key number 1: section thickness.**

  | Objective | 1 AU section in water (formula) | Repo plane-integrated FWHM | Note |
  |---|---|---|---|
  | 20x/0.75 | ≈ 3.2 µm | 2.6 µm | thin relative to the 8 µm bead |
  | 20x/0.80 | ≈ 2.8 µm | 2.3 µm | thin |
  | 10x/0.45 | ≈ 9.2 µm | 7.1 µm | thick; at least 4.6 µm even with the pinhole closed |

- **Key number 2: focus tolerance at 20x/0.80, 1 AU, index-matched bead.**
  - **Integrated signal F.** A 1 µm focal error changes F by 0.5–1.5%, and a 2 µm error by 4.6–6.8% (G to L). At 10x, 1 AU the losses are 1.9–2.3% and 7.3–8.8%.
  - **Rim peak.** It drops 12–18% at 1 µm and 40–54% at 2 µm (finely sampled). The repo's 20-pixel table shows 30% only because coarse pixels and profile smoothing blunt the peak.
  - **Quantify with F, not the peak.**
- **Key number 3: PE linearity.**
  - With confocal detection weighting, the signal is 5% sublinear at $k_0\approx0.08$, where $k_0$ is the excitation rate at the beam peak divided by the fluorescence decay rate. That occurs at about **2 µW at the sample (20x)** and **6–7 µW (10x)**; saturation ($k_0=1$) is at about 26–30 µW and 83 µW.
  - The earlier thresholds of 2.6–3 µW and 8 µW were about 25% too generous.
  - Set power in measured µW, never in % laser.
- **Key number 4: post-wash timing.**
  - With the biosensor value $k_{-2}=8.6\times10^{-4}$ s⁻¹, PE loss is 23% at 5 min and 54% at 15 min. With the bead-fitted $10^{-4}$ s⁻¹ it is 3% and 9% [S1].
  - For a 2% bias, timing must be held to within 23 s at the fast rate and 200 s at the slow one.
  - A 96-well plate takes about 20–25 min at one field per well (§D.3). So if Λ, the post-wash decay rate, is ≳ $5\times10^{-4}$ s⁻¹, the wash read has to be staggered by column, or replaced with a no-wash or fixed read.
- **Key number 5: bead number, incubation and limit of detection (LOD).**
  - In the depletion regime, PE per bead ∝ $A_TV/n_b$, so bead count is a calibration parameter. With $10^4$ beads in 50 µL, 1 h captures about 35–37% of the analyte.
  - **Optical LOD per bead at the recommended 2 µW, 20x:** about 64 PE washed; 91, 214 and 649 PE at 0.1, 1 and 10 nM free PE-antibody (no wash). Averaging 100 beads lowers these about 10× per well.
  - In the reference case (≈ 500 PE per bead per pM at 1 h), the per-well optical LOD is ≲ 0.05 pM. The real floor is therefore non-specific detection-antibody binding and its well-to-well variation, which still has to be measured (Exp. 9).
- **Strategy (four lines).**
  1. **Settings and focus.** 20x, 1 AU, 561 nm at 1–2 µW at the sample, galvano 1–2 µs dwell, 2048² at zoom 1 (0.43 µm pixels). Use one field per well (≈ 200+ beads), one exposure per field, and focus by transmitted light or Perfect Focus at the measured stationary point of F(z₀), which is the equator for an index-matched bead.
  2. **Segmentation and metric.** Segment beads and judge focus from the transmitted-light channel, not from PE. That avoids selection bias at low signal. The metric is F per bead, background-annulus subtracted, corrected for bead radius, taking the median of ≥ 100 beads per well.
  3. **Assay settings.** Fix $n_b/V$ and the incubation time. Settle beads by a brief plate spin. Use a column-staggered wash with a fixed, logged delay before imaging, or a no-wash read if Λ ≳ $5\times10^{-4}$ s⁻¹. Default $D_T\approx1$–$2K_2$.
  4. **Calibration.** Use a mechanistic or 5PL-plus-hook standard curve with a dilution check. Absolute PE per bead comes from a solution-PE reference, corrected by the measured section truncation factor $T$ and checked against flow cytometry.

---

## Part A: PE surface coverage on an 8 µm sandwich bead as a function of analyte concentration

### A.0 Main results

1. **If the epitopes are independent, the signal factors exactly.** Assume the detection antibody binds captured and free analyte equally ($K_2=K_4$), and capture works equally on labelled and unlabelled analyte ($K_3=K_1$). Then
   $$\theta_{PE}(t)=\theta_{cap}(t)\cdot g(t)$$
   - $\theta_{cap}$ is the fraction of sites holding analyte, labelled or not.
   - $g$ is the fraction of all analyte that carries a detection antibody.

   This holds at equilibrium. It also holds at all times when the rate constants match ($k_3=k_1$, $k_{-3}=k_{-1}$, $k_2=k_4$, $k_{-2}=k_{-4}$), including when the label is depleted. At equilibrium the PE route (pre-complex or surface labelling) does not matter; it affects only kinetics.
2. **Equilibrium reduces to two quadratics** (Chang's capture quadratic [S1] and a label-depletion quadratic). In the sharp-binding limit the hook appears automatically:
   - the maximum signal is about $\min(S_T,D_T)$;
   - the fall begins at $A_T\approx\max(S_T+K_1,\;D_T+K_2)$;
   - beyond that, $SAD\approx S_TD_T/(A_T+K_2)$.

   When $K_2\sim D_T$ the transition is soft. In the reference case the peak is at ≈ 0.7 nM.
3. **An 8 µm bead is in mixed transport/reaction control.** The per-bead diffusion-limited rate is $k_D=4\pi RD\approx0.9$–$2.6\times10^{12}\ \mathrm{M^{-1}s^{-1}}$, and Da ≈ 0.05–3. Da is highest for the large analyte–PE-antibody complex [S1, S2, S8, S14].
4. **Practical incubations are not at equilibrium.** Capture runs on the bulk clock $k_{cap}=c_bk_{bead}$, which is set by the **number of beads**.
   - In the reference case, 1 h captures about 35% of the analyte (full ODE) or 37% (closed form with constant Da, §A.3). The two differ because Da changes as sites fill and because the complex diffuses more slowly.
   - The signal roughly doubles between 1 h and 3 h.
5. **After the wash, the PE-only signal is a single exponential** at $k_{-2}+k_{-3}$. **The two off-rates cannot be separated from a PE time series alone** (§A.4).
6. **PE surface density has a steric ceiling** of about $0.35$–$1.2\times10^6$ PE per bead (about 1,700–5,800 PE/µm²).
   - The literature capture density extrapolates to about $2.8\times10^6$ IgG per 8 µm bead [S1].
   - So PE at saturation is at most about **0.05–0.4** of the coupled capture sites (§A.5).
   - At pM analyte the bead carries only about 1–10 PE/µm².
7. **The detection-antibody concentration $D_T$ is the main assay-design lever the model produces.** It sets the $k_{-2}$ sensitivity, the hook position, the no-wash background and the non-specific-binding (NSB) background. Default: $D_T\approx1$–$2K_2$ (§A.2.5).

---

### A.1 Species, reactions and rate constants

#### Species

| Symbol | Meaning | Where |
|---|---|---|
| $S$ | free functional capture paratope (capture IgG on the bead) | surface |
| $A$ | free analyte (one capture epitope and one detection epitope; assumption) | solution |
| $D$ | free PE-labelled detection antibody ($n_{PE}$ PE per IgG; assumption ≈ 1) | solution |
| $AD$ | analyte–detection-antibody pre-complex | solution |
| $SA$ | captured, unlabelled analyte (dark) | surface |
| $SAD$ | captured, labelled analyte (**the only specific species that emits**) | surface |
| $SD$ | detection antibody bound non-specifically to the bead or capture IgG (background) | surface |

**Per-bead quantities:**
- $N_S$: active capture sites per bead.
- $A_b=4\pi R^2=201\ \mu$m² for $R=4\ \mu$m.
- $\Gamma_S=N_S/A_b$: site density.

**Bulk-equivalent quantities** for $n_b$ beads in volume $V$:
$$c_b=\frac{n_b}{N_AV},\qquad S_T=c_bN_S,\qquad \phi=\frac{n_b\tfrac43\pi R^3}{V}$$
Surface species are written as bulk-equivalent molar concentrations: $[SAD]=c_b\,n_{SAD}$.

**Reference case** (an assumption, not lab data): $n_b=10^4$ beads in 50 µL. This gives:
- $c_b=3.3\times10^{-16}$ M;
- $\phi=5.4\times10^{-5}$;
- mean spacing between beads ≈ 171 µm;
- with $N_S=10^6$, $S_T=0.33$ nM.

#### Reactions

$$
\begin{aligned}
&(1)\quad A+S \underset{k_{-1}}{\overset{k_1}{\rightleftharpoons}} SA &&\text{capture of free analyte}\\
&(2)\quad D+SA \underset{k_{-2}}{\overset{k_2}{\rightleftharpoons}} SAD &&\text{labelling on the surface}\\
&(3)\quad AD+S \underset{k_{-3}}{\overset{k_3}{\rightleftharpoons}} SAD &&\text{capture of the pre-complex}\\
&(4)\quad A+D \underset{k_{-4}}{\overset{k_4}{\rightleftharpoons}} AD &&\text{pre-complexing in solution}\\
&(5)\quad D+S \underset{k_{-5}}{\overset{k_5}{\rightleftharpoons}} SD &&\text{non-specific background}
\end{aligned}
$$

**Detailed balance.** Reactions 1–4 form a thermodynamic cycle, so $K_1K_2=K_3K_4$ with $K_i=k_{-i}/k_i$. A parameter set that violates this produces a spurious cycle flux.

#### Simplifying assumptions (all of them assumptions)

| Assumption | Physical meaning | When it fails |
|---|---|---|
| $k_4=k_2,\ k_{-4}=k_{-2}$ | The detection epitope is equally accessible on free and captured analyte. | **Crowding:** the capture paratope may occlude the epitope. **Avidity:** a bivalent PE-IgG bridging two neighbouring SA lowers the effective $k_{-2}$ on the surface. Bridging is plausible when captured analytes lie within the ~10–15 nm IgG arm span, i.e. at high $\theta_{cap}$ with the ~8.5 nm site spacing of [S1]. |
| $k_3=k_1,\ k_{-3}=k_{-1}$ | Capture does not depend on whether the analyte is labelled. | **Sterics:** the ~390 kDa complex reaching a crowded IgG layer. **Transport:** $D_{AD}\approx3\times10^{-7}$ vs $D_A\approx6$–$9\times10^{-7}$ cm²/s. **Bivalent capture:** effective $K_D<10^{-11}$ M, estimated in [S1]. |
| One detection epitope per analyte | 1 PE-IgG per analyte | Multi-epitope or repeating-epitope analytes [S7]. A bivalent detection IgG holding two analytes ($A_2D$) at high $A_T$. |
| $n_{PE}=1$ | One PE per detection IgG | Commercial conjugates mix 0, 1 and 2 PE per IgG and contain free PE. Calibrate separately. |

If only the equilibrium constants are equal ($K_2=K_4$, which forces $K_3=K_1$), the **equilibrium** factorisation still holds but the kinetic one does not.

---

### A.2 Incubation model

#### A.2.1 ODE system (mass action, finite sites, finite volume, transport-corrected)

Write $S=S_T-[SA]-[SAD]-[SD]$ and $\Gamma_i=1/(1+\mathrm{Da}_i)$, with:
- $\mathrm{Da}_1=k_1n_S/k_{D,A}$
- $\mathrm{Da}_3=k_3n_S/k_{D,AD}$
- $\mathrm{Da}_2=k_2n_{SA}/k_{D,D}$
- $\mathrm{Da}_5=k_5n_S/k_{D,D}$

Here $n_S$ and $n_{SA}$ are the current numbers per bead. Each surface reaction's forward **and** reverse constants are divided by the same $1+\mathrm{Da}$ [S8, S14].

$$
\begin{aligned}
\frac{d[A]}{dt}&=-\Gamma_1\big(k_1[A]S-k_{-1}[SA]\big)-\big(k_4[A][D]-k_{-4}[AD]\big)\\
\frac{d[D]}{dt}&=-\Gamma_2\big(k_2[D][SA]-k_{-2}[SAD]\big)-\big(k_4[A][D]-k_{-4}[AD]\big)-\Gamma_5\big(k_5[D]S-k_{-5}[SD]\big)\\
\frac{d[AD]}{dt}&=\big(k_4[A][D]-k_{-4}[AD]\big)-\Gamma_3\big(k_3[AD]S-k_{-3}[SAD]\big)\\
\frac{d[SA]}{dt}&=\Gamma_1\big(k_1[A]S-k_{-1}[SA]\big)-\Gamma_2\big(k_2[D][SA]-k_{-2}[SAD]\big)\\
\frac{d[SAD]}{dt}&=\Gamma_2\big(k_2[D][SA]-k_{-2}[SAD]\big)+\Gamma_3\big(k_3[AD]S-k_{-3}[SAD]\big)\\
\frac{d[SD]}{dt}&=\Gamma_5\big(k_5[D]S-k_{-5}[SD]\big)
\end{aligned}
$$

**Conservation:**
- $A_T=[A]+[AD]+[SA]+[SAD]$
- $D_T=[D]+[AD]+[SAD]+[SD]$
- $S_T=S+[SA]+[SAD]+[SD]$

**Initial conditions (one-step format):** $[A]=A_T$, $[D]=D_T$, all others 0. A pre-mix variant starts $[AD]$ at its solution equilibrium.

**Observable:** $N_{PE}=n_{PE}([SAD]+[SD])/c_b$ per bead.

**Validity:**
- well-mixed bulk;
- $\phi\ll1$;
- quasi-steady diffusion, $t\gg R^2/D\approx0.2$–$0.5$ s.

#### A.2.2 Non-dimensional form

**Scaling.** Concentrations are divided by $S_T$; time is measured as $\tau=k_1S_Tt$.

**Variables:**
- $a=[A]/S_T$, $d=[D]/S_T$, $c=[AD]/S_T$
- $\theta_A=[SA]/S_T$, $\theta_{PE}=[SAD]/S_T$
- $s=1-\theta_A-\theta_{PE}$

**Parameters:** $\kappa_i=K_i/S_T$ (with $\kappa_1\kappa_2=\kappa_3\kappa_4$) and $\lambda_i=k_i/k_1$.

$$
\begin{aligned}
a'&=-\Gamma_1(as-\kappa_1\theta_A)-\lambda_4(ad-\kappa_4c)\\
d'&=-\lambda_2\Gamma_2(d\theta_A-\kappa_2\theta_{PE})-\lambda_4(ad-\kappa_4c)\\
c'&=\lambda_4(ad-\kappa_4c)-\lambda_3\Gamma_3(cs-\kappa_3\theta_{PE})\\
\theta_A'&=\Gamma_1(as-\kappa_1\theta_A)-\lambda_2\Gamma_2(d\theta_A-\kappa_2\theta_{PE})\\
\theta_{PE}'&=\lambda_2\Gamma_2(d\theta_A-\kappa_2\theta_{PE})+\lambda_3\Gamma_3(cs-\kappa_3\theta_{PE})
\end{aligned}
$$

with $a(0)=\alpha\equiv A_T/S_T$ and $d(0)=\delta\equiv D_T/S_T$.

| Group | Meaning |
|---|---|
| $\alpha$ | analyte relative to capture capacity |
| $\delta$ | label relative to capacity |
| $\kappa_1$ | capture affinity relative to capacity ($\kappa_1\ll1$ is the depletion, or "mass-sensing", regime) |
| $\kappa_2$ | label affinity |
| $\lambda_2,\lambda_4$ | speed of labelling relative to capture |
| $\mathrm{Da}_i$ | transport |
| $\tau_{inc}=k_1S_Tt_{inc}$ | incubation length |
| $\omega_i=k_{-i}/(k_1S_T)$ | off-rates on the capture clock |

#### A.2.3 Equilibrium

Under independence, and neglecting SD:
$$[SA]=\frac{S[A]}{K_1},\quad [AD]=\frac{[A][D]}{K_2},\quad [SAD]=\frac{S[A][D]}{K_1K_2}$$

$$\boxed{\theta_{PE}^{eq}=\underbrace{\frac{B}{S_T}}_{\theta_{cap}}\cdot\underbrace{\frac{D_f}{K_2+D_f}}_{f_D}}$$

**Capture** ($B=[SA]+[SAD]$; [S1]):
$$B=\tfrac12\Big[(K_1+S_T+A_T)-\sqrt{(K_1+S_T+A_T)^2-4S_TA_T}\Big]$$

**Label depletion.** Exactly, $D_T=D_f+A_T\frac{D_f}{K_2+D_f}$, so
$$D_f=\tfrac12\Big[-(K_2+A_T-D_T)+\sqrt{(K_2+A_T-D_T)^2+4K_2D_T}\Big]$$

**Consequences:**
- The equilibrium signal does not depend on the route.
- It depends on the label only through $A_T$, $D_T$ and $K_2$.
- If $K_2\neq K_4$, the two quadratics couple (a 2-D root find) and the factorisation is lost.

**Closed forms:**

| Limit | Condition | $N_{PE}$ per bead |
|---|---|---|
| Excess label | $D_T\gg A_T$, $D_T\gg S_T$ | $N_S\,\theta_{cap}\,D_T/(K_2+D_T)$ |
| Ambient analyte | $S_T\ll K_1+A_T$ | $\theta_{cap}=A_T/(K_1+A_T)$: a 4PL with Hill slope 1 and EC₅₀ $=K_1$, independent of $n_b$ |
| Mass-sensing (depletion) | $S_T\gg K_1$, $A_T<S_T$ | $N_{PE}\approx f_DA_TN_AV/n_b$: linear in $A_T$, ∝ 1/bead number |
| Fast pre-complex | $k_4D_T\gg k_{cap}$ | Equilibrium unchanged; kinetically, capture runs at $k_3\Gamma_3$ |
| Hook | $A_T\gg D_T+K_2$ and $A_T\gg S_T+K_1$ | $N_{PE}\approx N_SD_T/(A_T+K_2)\propto1/A_T$ |

**When a 4PL fit is adequate.** A 4PL is justified for the ideal two-site model [S13], but only in the ambient, excess-label, single-affinity regime. It fails in four cases:
1. **Depletion:** a linear rise and an abrupt plateau, giving an apparent slope above 1.
2. **Affinity heterogeneity:** an apparent slope below 1 [S13].
3. **Hook:** the curve is non-monotonic.
4. **Non-equilibrium readout:** the EC₅₀ drifts with $t_{inc}$ and $n_b$.

In those cases use the mechanistic model, or a 5PL with an explicit hook term.

**Hook (sharp-binding limit):** $SAD\approx\min(A_T,S_T)\cdot\min(1,D_T/A_T)$. The signal rises linearly, plateaus at $\min(S_T,D_T)$, and falls as $S_TD_T/A_T$ above $A_{hook}\approx\max(S_T+K_1,D_T+K_2)$.

This reproduces three published observations [S7]:
- the one-step hook occurs whatever the analyte;
- higher capture capacity moves it to higher concentration;
- label concentration matters.

The washed two-step "ideal" model has no hook [S13]; a one-step assay keeps free analyte present by construction. At finite time a **kinetic hook** can appear earlier: when $k_4D_Tt\gtrsim1$ while $\theta_{cap}$ saturates quickly, free analyte competes for the label.

**Off-rate sensitivity of equilibrium SAD** (exact; checked numerically):

$$\frac{\partial\ln SAD}{\partial\ln k_{-1}}=-\frac{K_1}{\sqrt{(K_1+S_T+A_T)^2-4S_TA_T}}$$
This tends to $-(1-\theta_{cap})$ with no depletion and to ≈ 0 in deep depletion.

$$\frac{\partial\ln SAD}{\partial\ln k_{-2}}=\frac{K_2}{K_2+D_f}\left(\frac{K_2D_f'}{D_f}-1\right),\qquad D_f'=\frac{D_T-D_f}{\sqrt{(K_2+A_T-D_T)^2+4K_2D_T}}$$
This tends to $-(1-f_D)$ with excess label and to ≈ 0 in the deep hook.

| Reference case | 1 pM | 1 nM | 10 nM |
|---|---|---|---|
| $\partial\ln SAD/\partial\ln k_{-1}$ | ≈ −0.06 | ≈ −0.03 | — |
| $\partial\ln SAD/\partial\ln k_{-2}$ | ≈ −0.52 | — | ≈ −0.20 |

**At the low end, the signal is controlled by $K_2$, not by $K_1$,** because the beads deplete the analyte.

#### A.2.4 Closed-form kinetics at low analyte ($A_T\ll S_T,D_T$)

$$P_{cap}(t)=\frac{k_{cap}}{k_{cap}+k_{-1}^e}\Big(1-e^{-(k_{cap}+k_{-1}^e)t}\Big),\qquad g(t)=\frac{k_2D_T}{k_2D_T+k_{-2}}\Big(1-e^{-(k_2D_T+k_{-2})t}\Big)$$
$$N_{PE}(t)=n_{PE}\frac{A_TN_AV}{n_b}P_{cap}(t)\,g(t),\qquad k_{cap}=c_bk_{bead}$$

**Check against [S1].** For the PSA detection antibody ($k_2=3.9\times10^5$, $k_{-2}=8.6\times10^{-4}$) at 1 nM:
- $g(1000\,\mathrm s)=0.22$;
- $g(3600\,\mathrm s)=0.31$.

Both match [S1]. The paper's "≈ 50% at equilibrium" applies only to a hypothetical $K_D=1$ nM.

**Reference-case simulation** (full ODE with time-dependent $\Gamma_i$; parameters are assumptions within the ranges of [S1]):
- $n_b=10^4$ in 50 µL, $N_S=10^6$
- $k_1=5\times10^5$, $k_{-1}=10^{-5}$ ($K_1=20$ pM)
- $k_2=k_4=4\times10^5$, $k_{-2}=8.6\times10^{-4}$ ($K_2=2.15$ nM), $D_T=2$ nM
- $D_A=6\times10^{-7}$, $D_D=3.5\times10^{-7}$, $D_{AD}=3\times10^{-7}$ cm²/s

| $A_T$ | $N_{PE}$ at 1 h | 3 h | equilibrium | captured fraction, 1 h | labelled fraction of captured, 1 h |
|---|---|---|---|---|---|
| 1 fM | 0.5 | 1.0 | 1.4 | 0.35 | 0.47 |
| 1 pM | 5.0e2 | 1.0e3 | 1.4e3 | 0.35 | 0.47 |
| 100 pM | 4.8e4 | 9.5e4 | 1.3e5 | 0.34 | 0.47 |
| 1 nM | 3.0e5 | 4.0e5 | 4.1e5 | 0.24 | 0.42 |
| 3 nM | 3.2e5 | 3.2e5 | 3.2e5 | 0.11 | 0.32 |
| 10 nM | 1.6e5 | 1.6e5 | 1.6e5 | 0.03 | 0.16 |
| 1 µM | 2.0e3 | 2.0e3 | 2.0e3 | — | 0.002 |

- **Peak.** The equilibrium peak is at $A_T\approx0.7$ nM with $N_{PE}\approx4.2\times10^5$ per bead ($\theta_{cap}=0.95$, $f_D=0.48$ at $D_T=2$ nM). That is already at the steric ceiling (§A.5).
- **Labelled fraction.** It falls about 2% short of $g(1\,\mathrm h)=0.48$ because $\mathrm{Da}_3>\mathrm{Da}_1$.
- **Low concentrations.** Below about 100 fM, per-bead counts are Poisson. At 1 fM there is less than one PE per bead, which is a digital regime, not an analog intensity.
- **Working range.** Concentration precision is signal CV divided by the local log slope $d\ln N_{PE}/d\ln A_T$. At 1 h the slope is ≈ 1 up to ~100 pM, ≈ 0.8 from 0.1 to 1 nM, and → 0 at the 0.7–3 nM peak. The usable range at 1 h therefore ends near 0.5–1 nM.
- **Repo mismatch.** The repo figure `fig1_binding.png` uses different defaults ($K_{D1}=1$ nM, $K_{D2}=10$ nM, 5,000 beads, a capacity of 166 pM). It does **not** depict this reference case (§C.3).

#### A.2.5 Choosing the detection-antibody concentration $D_T$ (derived; `report_calcs/dt.py`)

Equilibrium values in the reference case ($S_T=0.33$ nM, $K_1=20$ pM, $K_2=2.15$ nM):

| $D_T$ | $f_D$ (= $g$ at 1 h) | $\partial\ln SAD/\partial\ln k_{-2}$ at 1 pM | Peak $A_T$ | $N_{PE}$ at peak | Falling branch at half-peak | No-wash background at 20x |
|---|---|---|---|---|---|---|
| 1 nM | 0.32 | −0.68 | 0.6 nM | 2.6e5 | 5.2 nM | 1.8–2.7 PE/µm² |
| 2 nM | 0.48 | −0.52 | 0.7 nM | 4.2e5 | 6.8 nM | 3.6–5.3 |
| 5 nM | 0.70 | −0.30 | 0.95 nM | 6.5e5* | 12 nM | 9–13 |
| 10 nM | 0.82 | −0.18 | 1.4 nM | 7.9e5* | 22 nM | 18–27 |
| 20 nM | 0.90 | −0.10 | 2.3 nM | 8.8e5* | 41 nM | 36–53 |

\* These exceed the steric ceiling for PE-IgG footprints ≥ 15 nm (§A.5), so the real top of the curve is lower.

**Trade-off.** Non-specific binding scales roughly as $k_5D_T$ when coverage is low (assumption). The specific signal per pM scales as $f_D=D_T/(K_2+D_T)$.
- An **NSB-limited LOD** therefore scales as $\propto(K_2+D_T)$. It always gets worse with more label, but by at most 2× up to $D_T=K_2$.
- An **optics- or Poisson-limited LOD** scales as $\propto1/f_D$ and improves with more label.

**Rule (derived):**
- Default to $D_T\approx1$–$2K_2$.
- Go to $2$–$5K_2$ only if Exp. 9 shows NSB below the Poisson and optical floor. This also halves the $k_{-2}$ sensitivity and pushes the hook up about 2×.
- [S1] kept the detection antibody near 1 nM for exactly this reason: background came mostly from labelling reagent binding the immobilised capture antibody.

**One-step or two-step.** Switch to a two-step format (capture, wash, then label) or make dilution mandatory under either of two conditions:
- the expected upper sample concentration comes within 10× of the falling-branch half-peak concentration (≈ 7 nM at $D_T=2$ nM here);
- the dilution-concordance check (§D.1) fails in more than ~1% of samples.

A two-step assay removes the free-analyte hook. A residual hook can remain from capture-site heterogeneity or incomplete washing [S13].

---

### A.3 Transport

**Diffusion-limited rate to an absorbing sphere** [S2, S8, S14]: $k_D=4\pi RD$.

| Species | $D$ (cm²/s) | $k_D$ per 8 µm bead (M⁻¹s⁻¹) | Flux at 1 fM / 1 pM / 1 nM (molecules/s) | $R^2/D$ |
|---|---|---|---|---|
| PSA-size analyte | 8.5e-7 [S1] | 2.6e12 | 0.0026 / 2.6 / 2,600 | 0.19 s |
| ~50–80 kDa analyte | 6e-7 (assumption) | 1.8e12 | 0.0018 / 1.8 / 1,800 | 0.27 s |
| IgG | 3.9e-7 [S1] | 1.2e12 | — | 0.41 s |
| PE-IgG, $AD$ (~390 kDa) | ~3e-7 (assumption, $M^{-1/3}$ scaling; Part E) | 0.9e12 | — | 0.53 s |

**Ceiling on capture.** At 1 pM a bead can capture at most about $6.5\times10^3$ analyte molecules per hour (32 per µm²), however many antibodies it carries.

**Transport plus intrinsic kinetics** [S2, S8, S14]:
$$k_{bead}=\frac{k_DN_Sk_{on}}{k_D+N_Sk_{on}},\quad \mathrm{Da}=\frac{N_Sk_{on}}{k_D},\quad k_{on}^e=\frac{k_{on}}{1+\mathrm{Da}},\quad k_{off}^e=\frac{k_{off}}{1+\mathrm{Da}}$$

**Consequences:**
- $K_D$ is unchanged by transport, so the isotherm is unchanged; only the time to reach it changes [S14].
- The fraction of dissociations that rebind is $\mathrm{Da}/(1+\mathrm{Da})$ [S8].
- Transport limitation is half-maximal at $N_{1/2}=4\pi RD/k_{on}\approx1$–$3\times10^6$ sites [S2].
- Random site placement behaves like uniform placement within a few percent; clustered sites do not [S2].

| Process | Da | Regime |
|---|---|---|
| $A$ onto $S$ ($N_S=10^6$, $k_1=5\times10^5$) | 0.28 | ~20% slowed |
| $AD$ onto $S$ (same) | 0.55 | ~35% slowed |
| $A$ onto $S$ ($N_S=2.8\times10^6$, $k_1=10^6$) | 1.1–1.5 | mixed |
| $AD$ onto $S$ (same) | ≈ 3 | transport-dominated |
| $D$ onto $SA$ at low analyte | < 0.05 | reaction-limited |
| $D$ onto $SA$ near saturation | ≈ 0.4 | mixed |

**Transients.** The excess flux decays as $(R^2/\pi Dt)^{1/2}$: about 25–35% at 1 s and below 5% after about 20–50 s [S2, S8, S14].

**Static vs agitated incubation** (derived; densities are assumptions):
- **Sedimentation.** An 8 µm polystyrene bead (Δρ ≈ 50 kg/m³) sediments at $v=\tfrac29\Delta\rho gR^2/\mu\approx1.7$ µm/s. That is about 15 min to fall through 1.5 mm of liquid.
- **Agitation and flux to one bead.** The bead-scale Péclet number is ≈ 0.1, so shear raises the flux to a single bead by only about 10–30%.
- **Agitation and suspension.** Keeping beads suspended matters much more. A settled monolayer clears the liquid above it in $H^2/2D\approx5$–9 h.
- **Recommendation:** continuous end-over-end or orbital mixing.

**Time to equilibrium (depletion regime).** Captured fraction at 1 h from the closed form $1-e^{-k_{cap}t}$ with constant Da. The full ODE gives 0.35 for $10^4$ beads, because Da rises as the complex fraction grows.

| $n_b$ in 50 µL | $k_{cap}$ (s⁻¹) | $1/k_{cap}$ | Captured fraction at 1 h |
|---|---|---|---|
| $10^3$ | 1.3e-5 | 21 h | 0.05 |
| $10^4$ | 1.3e-4 | 2.1 h | 0.37 |
| $10^5$ | 1.3e-3 | 13 min | 0.99 |

- **Ambient regime** (few beads): reaching equilibrium takes days, so the readout is an initial rate.
- **Labelling:** $t_{95}\approx40$ min at 1 nM label; about 10 min at 10 nM.

**Bead-number trade-off.** PE per bead ∝ $(V/n_b)(1-e^{-k_{cap}t})$.
- For $k_{cap}t\ll1$ it is independent of $n_b$.
- For $k_{cap}t\gg1$ it is ∝ $1/n_b$.
- Choose $n_b$ near $k_{cap}t_{inc}\approx1$ and keep it fixed.

**Bead-size polydispersity** (derived). Let $c_R$ be the size CV (2–5% is typical; assumption, check the vendor CoA).
- **Depletion regime:** analyte is shared ∝ $k_{bead,i}$, which is ∝ $R$ (transport-limited) to $R^2$ (reaction-limited). So $N_{PE}\propto R^{1\text{–}2}$ and $\sigma_s\propto R^{-1\text{–}0}$.
- **Ambient regime:** $N_{PE}\propto R^2$ and $\sigma_s$ is constant.
- **Effect on each metric:**
  - 20x thin-section metric: $F=2\pi R\sigma_s\ell_{eff}T\propto R^{0\text{–}1}$;
  - 10x thick limit: $F\propto R^2\sigma_s\propto R^{1\text{–}2}$.
- Size CV therefore adds 0–1× $c_R$ at 20x and 1–2× $c_R$ at 10x to the bead-to-bead CV.
- **Correction:** measure each bead's $R$ from the transmitted-light image or the ring fit, and report $N_{PE}=2R\,F/(\ell_{eff}T)$ (20x) or $\sigma_s$.

---

### A.4 Wash and imaging phase

After the wash, $[A]=[D]=[AD]=0$. Residual label from an incomplete wash re-labels SA and is added as a source term if present. Rebinding is absorbed into $k_{-i}^e=k_{-i}/(1+\mathrm{Da}_i)$ [S8, S14].

$$\frac{d[SAD]}{dt}=-(k_{-2}^e+k_{-3}^e)[SAD],\qquad \frac{d[SA]}{dt}=k_{-2}^e[SAD]-k_{-1}^e[SA]$$

With $\Lambda=k_{-2}^e+k_{-3}^e$:
$$[SAD](t)=[SAD]_0e^{-\Lambda t},\qquad [SA](t)=[SA]_0e^{-k_{-1}^et}+\frac{k_{-2}^e[SAD]_0}{k_{-1}^e-\Lambda}\big(e^{-\Lambda t}-e^{-k_{-1}^et}\big)$$

**PE observable:** $N_{PE}(t)=N_{PE}(0)e^{-\Lambda t}$, plus SD decaying at $k_{-5}$. A bi-exponential PE decay points to something outside the model:
1. two affinity classes [S13], or monovalent vs bridging detection antibodies;
2. re-labelling from residual detection antibody;
3. a slow non-specific component;
4. photophysics (Part B);
5. the $t^{-3/2}$ rebinding tail, which appears only after about 95% has decayed [S14].

**Identifiability.** Only $N_{PE}(0)$ and Λ are identifiable from PE versus time. **$k_{-1}$ cannot be separated from $k_{-2}$ with PE-only data.** In practice capture is nearly irreversible ($k_{-1}=3\times10^{-6}$ s⁻¹; effective $K_D<10^{-11}$ M estimated [S1]), so Λ ≈ $k_{-2}^e$ [S1].

**Designs that separate the off-rates:**

| Design | Protocol | What it measures |
|---|---|---|
| **Relabel pulse** | Wash and hold for $t_d$. Image aliquot 1 as is. Give aliquot 2 saturating PE-D (≥ 10 nM, $k_2D_rt_r\ge3$), wash, and image at once. | Relabelled signal ∝ $C_0e^{-k_{-1}^et_d}$, giving $k_{-1}^e$. The ratio of unrelabelled to relabelled signal gives $k_{-2}^e$. |
| **Detection-antibody clamp** | Hold the beads in a fixed $D_c$ and image without washing. | $N_{PE}(t)=f_cC_0e^{-k_{-1}^et}$, giving $k_{-1}^e$ |
| **Directly labelled analyte** | Dye-labelled analyte, no detection antibody. | $k_{-1}^e$ and active $N_S$ |
| **Rebinding check** | Dissociate into excess soluble capture IgG. | Intrinsic vs effective $k_{-i}$, only when Da ≫ 1 [S14] |

**PE lost between the end of the wash and imaging**, $1-e^{-k_{-2}t}$:

| Delay | $k_{-2}=8.6\times10^{-4}$ s⁻¹ (biosensor [S1]) | $1\times10^{-4}$ s⁻¹ (bead fit [S1]) |
|---|---|---|
| 5 min | 23% | 3% |
| 15 min | 54% | 9% |
| 30 min | 79% | 17% |
| 60 min | 96% | 30% |
| 120 min | ~100% | 51% |

**Timing tolerance** (derived). A timing jitter δt gives a relative bias of ≈ Λδt.

| Λ (s⁻¹) | δt for 2% bias | δt for 5% bias |
|---|---|---|
| $1\times10^{-4}$ | 200 s | 500 s |
| $5\times10^{-4}$ | 40 s | 100 s |
| $8.6\times10^{-4}$ | 23 s | 58 s |

**The Λ correction.** A correction $F\,e^{\Lambda\Delta t}$ carries a relative error of $\Lambda\Delta t\cdot\mathrm{SE}(\Lambda)/\Lambda$. **Use it only where ΛΔt ≤ 0.2** (≤ 2% error when SE(Λ)/Λ = 10%). Above that the correction amplifies error.

**Ways to avoid the dissociation window:**
- **Fixed, identical timing** for every sample and standard, or freezing the complexes. Sucrose drying gave CVs of 4–8% across reads 5 min to 2 h after loading [S1]. Drying changes the optics, so a dried read needs dried standards (§B.8).
- **A no-wash read.** It adds a solution background of $c\,\ell_{eff}$: 1.8–2.7 PE/µm² per nM at 20x and 5.9–8.7 at 10x (§B.4.6). This competes with surface PE only below about 1–10 PE/µm², so a no-wash read suits the mid-to-high range. FMAT-style homogeneous confocal bead assays are prior art for this format (not reviewed here; Part E).
- **Temperature.** Off-rates and R-PE emission both depend on temperature ([S15] measured fluorescence vs temperature). Hold the stage and room temperature fixed and log them. If temperature varies, correct Λ with a measured Arrhenius factor (assumption).

**Fitting Λ:**
- **Precision:** $\mathrm{SE}(k)\approx\sqrt2c_v/(\sqrt nT)$, about 2% for $c_v=0.15$, $n=100$, $kT\approx1$.
- **Sampling span:** to $kT\approx1$–2. That is hours for $10^{-4}$ s⁻¹, and only an upper bound is practical for $k_{-1}$.
- **Destructive vs repeated sampling:** fresh beads per time point avoid bleaching. Repeated imaging of the same beads needs a bleach correction.

---

### A.5 Conversion to the optical observable

**Surface density.** $\sigma_{PE}=N_{PE}/201\ \mu$m², uniform if coupling is uniform [S2].

**Capture-site density.** [S1] measured 274,000 IgG per 2.5 µm bead. That is about 72 nm² per IgG; the paper's "15 nm square" is inconsistent with its own count. At that density an 8 µm bead carries about $2.8\times10^6$ IgG, or about $0.9\times10^6$ at the stated 225 nm². The active fraction is assumed to be 0.1–0.5.

**Steric ceiling** (random sequential adsorption jamming 0.547, textbook; footprint is an assumption):

| Projected diameter | Area per PE | Max PE per bead | Max PE/µm² |
|---|---|---|---|
| 11 nm (bare R-PE) | 174 nm² | 1.2e6 | 5,800 |
| 15 nm | 323 nm² | 6.2e5 | 3,100 |
| 18 nm | 465 nm² | 4.3e5 | 2,150 |
| 20 nm | 574 nm² | 3.5e5 | 1,750 |

$$\frac{N_{PE}^{max}}{N_S^{coupled}}\le f_D^{eq}\times\min\!\Big(1,\frac{N_{steric}}{N_S^{active}}\Big)\times\frac{N_S^{active}}{N_S^{coupled}}\approx0.05\text{–}0.4$$

**Density-dependent brightness (assumption; new).** At the top of the curve, PE sits 15–25 nm apart, centre to centre. Three things could lower brightness per PE as density rises, and could make bleaching cooperative:
- inter-protein homo-FRET onto photodamaged PE acting as energy traps;
- crowding;
- the R-PE dark state [S15].

That would bend the top of the curve and could be mistaken for steric saturation or the hook. **Test:** mix PE-D with unlabelled D at fixed total $D_T$. Binding stays fixed while PE density varies, so F should be linear in the labelled fraction (Exp. 7 extension).

**Photophysics per R-PE molecule.** ε, $\Phi_F$ and $\tau_f$ are textbook values not in the cited sources (Part E). The repo uses $\tau_f=2.5$ ns, which shifts $I_{sat}$ by 8%.

| Quantity | Value |
|---|---|
| ε | $1.96\times10^6$ M⁻¹cm⁻¹ at 565 nm; ≈ 0.95× at 561 nm; ≈ 0.5–0.75× at 488 nm |
| σ | ≈ $7.3$–$7.5\times10^{-15}$ cm² |
| $\Phi_F$, $\tau_f$ | ≈ 0.82, ≈ 2.7 ns |

$$k=\sigma I\tau_f,\qquad F_{em}=\frac{\Phi_F}{\tau_f}\frac{k}{1+k},\qquad k_{bl}=\phi_d\frac{\sigma I}{1+k},\qquad\phi_d=1.1\times10^{-5}\ [\text{S3}]$$

- **Saturation:** $I_{sat}=1/(\sigma\tau_f)\approx5\times10^{22}$ photons cm⁻²s⁻¹, consistent with [S9]. That corresponds to ≈ 83 µW (10x/0.45), 30 µW (20x/0.75) and 26 µW (20x/0.80) at the sample (§B.4.2); the response is sublinear above this [S15].
- **Photon budget:** about $9\times10^4$ absorptions (≈ $7.5\times10^4$ emitted photons) per R-PE before destruction [S3]. This improves 1.7× with n-propyl gallate [S3, S15].
- **Bleaching at saturation:** $k_{bl}\to\phi_d/\tau_f\approx4\times10^3$ s⁻¹, the same order as B-PE [S9].

**Hand-off to Part B.** Reference-case densities at 1 h: 1 pM ≈ 2.5 PE/µm²; 100 pM ≈ 240; peak ≈ 1,500–2,100.

---

### A.6 Parameter table

| Symbol | Meaning | Typical value / range | Source |
|---|---|---|---|
| $R$ | bead radius | 4 µm (201 µm², 268 µm³); size CV 2–5% | given; CV assumption |
| $N_S$ | active capture sites per bead | 3e5–3e6 | [S1] extrapolated; activity assumed |
| $n_b$, $V$ | beads, volume | 1e3–1e5 in 50–100 µL | assumption ([S1]: 5e5 in 100 µL) |
| $S_T$ | capture-site concentration | 0.03–3 nM | [S1]; derived |
| $k_1$ (=$k_3$) | analyte on-rate | 9e4–1.2e6 M⁻¹s⁻¹ | [S1] |
| $k_{-1}$ (=$k_{-3}$) | analyte off-rate | 3e-6–1.3e-3 s⁻¹ | [S1], [S8], [S14] |
| $K_1$ | capture $K_D$ | 12 pM–1 nM | [S1] |
| $k_2$ (=$k_4$) | detection on-rate | ~4e5 | [S1] |
| $k_{-2}$ (=$k_{-4}$) | detection off-rate | 8.6e-4 (biosensor); ~1e-4 (bead fit) s⁻¹ | [S1] |
| $K_2$ | detection $K_D$ | ~2.2 nM | [S1] |
| $D_T$ | detection-antibody concentration | 1–2 × $K_2$ default (§A.2.5) | derived |
| $k_5,k_{-5}$ | non-specific label binding | unknown; dominant background | [S1] qualitative; Exp. 9 |
| $D_A$, $D_D$, $D_{AD}$ | diffusion coefficients | 5–9e-7; 3–4e-7 cm²/s | [S1]; assumption |
| $k_D$ | Smoluchowski rate per bead | 0.9–2.6e12 M⁻¹s⁻¹ | [S2, S8, S14] |
| Da | $N_Sk_{on}/k_D$ | 0.05–3 | derived |
| $n_{PE}$ | PE per detection IgG | ~1 (heterogeneous) | assumption |
| $\phi_d$ | R-PE photodestruction yield | 1.1e-5 (6.5e-6 with n-propyl gallate) | [S3] |
| $I_{sat}$ | saturation irradiance | ~5e22 cm⁻²s⁻¹ | derived; consistent with [S9] |
| Dark state | reversible R-PE blinking | ms | [S15] |
| PE ceiling | jammed PE-IgG | 0.35–1.2e6 per bead | geometric assumption |

### A.7 What is established, derived and assumed in Part A

- **Established:**
  - capture Langmuir with depletion; rate ranges; post-wash loss dominated by the detection antibody; sucrose fixation [S1];
  - N-disk transport [S2];
  - the $(1+\mathrm{Da})$ factors and $K$ unchanged by transport [S8, S14];
  - the one-step hook [S7];
  - heterogeneity and incomplete-wash hooks [S13];
  - R-PE photophysics [S3, S9, S15].
- **Derived here:**
  - the factorisation and the quadratics;
  - hook and sensitivity formulas;
  - the $D_T$ rule;
  - post-wash non-identifiability and the relabel/clamp designs;
  - timing tolerances;
  - polydispersity propagation;
  - transport numbers.
- **Assumed:**
  - $N_S$ activity, independence of epitopes, $n_{PE}$, $D_{AD}$;
  - R-PE ε/Φ/τ, PE footprint, size CV;
  - NSB scaling with $D_T$;
  - the reference parameter set.

---

## Part B: Image formation for a fluorescent spherical shell on a Nikon AX-R (10x/0.45; 20x/0.75 or 0.80), single focal plane

> **Objective NA check.** Nikon's CFI Plan Apochromat **Lambda D** 20X is **NA 0.80** (WD 0.80 mm, fixed 0.17 mm coverglass, no correction ring) [S11]. A 20x/0.75 is a different model, so read the engraving on the barrel.
>
> **Model basis (derived).**
> - 561 nm excitation; PE emission at 575 nm; aqueous sample ($n=1.33$); dry objective without spherical aberration.
> - The shell is index-matched and non-absorbing unless stated otherwise (§B.1.4 relaxes this).
> - Three axial models (G, R, L) are used, as defined in the Conventions.

### B.1 Geometry: a thin shell versus a volume-labelled bead

#### B.1.1 The object

The capture-Ab/analyte/PE-Ab layer is about 20–40 nm thick, so it is modelled as an infinitely thin shell of uniform surface density $\sigma_s$:
$$N_{PE}=4\pi R^2\sigma_s\approx201\,\sigma_s$$

The realistic range is $\sigma_s\sim0.1$–$5\times10^3$ µm⁻² (about 20 to $10^6$ PE per bead), capped by the steric ceiling of §A.5.

$$\rho_{shell}(\mathbf r)=\sigma_s\,\delta(|\mathbf r|-R),\qquad\rho_{core}(\mathbf r)=c\,\Theta(R-|\mathbf r|)$$

#### B.1.2 Projected densities: why a shell gives a ring

Each hemisphere contributes $\sigma_sR/\sqrt{R^2-\rho^2}$ per unit projected area. This is **limb brightening**. A filled core projects instead to a dome, $2c\sqrt{R^2-\rho^2}$.

| Section regime | Shell image | Core image |
|---|---|---|
| Thin ($\text{FWHM}_z\ll R$) | Bright ring near R; dim interior. The centre value is $2\sigma_s\,w(R)$, which **measures the axial tail directly** (§B.3.3). | Flat-topped disc |
| Thick ($\text{FWHM}_z\gtrsim2R$) | Filled disc with a bright rim: centre ≈ $2\sigma_s w(R)$, rim ≈ 5× centre | Dome, dark rim |
| Integrated intensity vs focus | Flat plateau in thin-section mode (index-matched bead; §B.3.4) | ∝ $R^2-z_0^2$ |

**Simulated images.** `bead_confocal_sim/figures/fig2_gallery.png` shows shell beads at 10x/1 AU, 10x/2 AU, 20x/1 AU and 20x/4 AU, plus a volume-stained bead at 20x/1 AU, each at $z_0$ = 0, 2 and 3.5 µm. `figures/fig7_profiles.png` gives the radial profiles at 20x and 10x, 1 AU, for $z_0$ = 0–3.5 µm. These are the direct pictures of the shell signature:
- at 20x, a sharp ring with a dark interior (peak/centre ≈ 15 at 20 pixels per bead);
- at 10x, a filled disc with a bright rim (peak/centre ≈ 4.5);
- for a core bead, a uniform disc (peak/centre ≈ 1).

#### B.1.3 Sitting geometry

- On an inverted Ti2 the beads settle onto a #1.5H coverslip, so each equator sits about 4 µm into the water. All equators are coplanar to within (size CV × R), about ±0.1–0.2 µm (assumption).
- A stage move Δz moves the focus by about $1.33\,\Delta z$ in the sample (paraxial scaling [S4]).

#### B.1.4 The bead's own optics: refraction, absorption and near-interface emission (revised)

**Geometry of the problem.** The objective is below the bead. When the focus is at the equator, half of the integrated signal comes from the **upper** hemisphere ($z>0$). Light from a point at height z on the upper hemisphere must cross a chord of the bead (length ≈ 2z for paraxial rays) to reach the objective. Excitation light crosses the bead too. The previous revision looked only at the far cap and missed this.

**Ray-trace estimate** (derived; `report_calcs/ray.py`, `report_calcs/ray2.py`):
- **Method.** Geometric optics in 3-D with isotropic emitters on the shell, Snell refraction with total internal reflection, and up to six surface interactions. A ray counts if it leaves heading into the objective's acceptance cone. Fresnel losses, pinhole rejection of aberrated light and excitation are **not** included.
- **Quantity reported.** $c(z)$ is collection relative to an index-matched bead at the same emitter height.

| Bead index (in water) | $c(z)$ at z = −3 / −1 / −0.3 / +0.3 / +1 / +3 µm (20x/0.80) | Weighted over the 20x section (G), focus at $z_0$ = −2 / −1 / 0 / +1 / +2 µm |
|---|---|---|
| 1.33 (matched; control) | 1.00 / 1.00 / 1.00 / 1.00 / 0.99 / 1.00 | 1.00 at all $z_0$ |
| 1.45 (silica) | 1.01 / 0.75 / 0.59 / 0.50 / 0.73 / 1.53 | 0.88 / 0.77 / 0.73 / 0.83 / 1.08 |
| 1.49 (PMMA) | 1.00 / 0.76 / 0.59 / 0.45 / 0.56 / 1.59 | 0.88 / 0.75 / 0.67 / 0.77 / 1.06 |
| 1.59 (polystyrene) | 1.00 / 0.75 / 0.59 / 0.45 / 0.28 / 1.68 | 0.87 / 0.73 / 0.60 / 0.63 / 0.97 |

**What the trace shows.** Near the equator, part of the downward collection cone of a rim emitter points into the bead. Those rays are refracted out of the cone; the deviation at near-grazing entry is up to ~70° for relative index 1.2.

**Consequences:**
1. **A lower equatorial signal.** For a polystyrene, PMMA or silica bead in water, the equatorial signal is about 0.6–0.75 of the index-matched value from collection alone, and lower again once excitation through the bead is included.
2. **An asymmetric F(z₀).** Higher planes see the ball-lens concentration from the upper cap ($c>1$ at z ≈ +3 µm). The pinhole probably rejects most of that light because the virtual source moves 1–2 µm. Net result: the Archimedes plateau and the 0.5–1.5%-per-µm focus tolerance of §B.3.4 are **not guaranteed** for a real bead.
3. **Relative quantitation is still valid** at a fixed, reproducible focal plane on beads of one material and size. **Absolute** calibration against a solution reference (§B.3.4) is biased by the same factor.
4. **Lower hemisphere.** Below z ≈ −1.5 µm the lower hemisphere is almost unaffected ($c\approx0.95$–1.0). Focusing 1.5–2 µm **below** the equator therefore gives a signal less sensitive to bead optics, at the cost of sitting on the shoulder of the focus plateau.

> **Editor's note (`report_calcs/ray2.py`, run 2026-10-24).** The "lower again with excitation" statement holds at 20x/0.80: squaring c(z) for the excitation path takes the polystyrene equatorial factor from 0.60 to 0.42 (PMMA 0.67 → 0.50, silica 0.73 → 0.56). At **10x/0.45 the sign flips**: the thick section collects the upper cap, where the bead concentrates light (c ≈ 2 at z ≈ +3 µm), so the emission-only factor is 0.87–0.99 and the emission × excitation factor 1.29–2.14 across focus for polystyrene. Both are geometric estimates without the pinhole; they agree only that the bead's optics are large and objective-dependent, which is why F(z₀) has to be measured on each objective (Exp. 5).

**Practical rule (derived).**
- Measure F(z₀) through single beads (Exp. 5).
- Put the routine focal plane at the **measured stationary point** of F(z₀), where $dF/dz_0=0$, wherever it falls. For an index-matched bead that is the equator.
- An asymmetric F(z₀) about the geometric equator is the diagnostic of bead optics.

**Magnetic (iron-oxide-loaded) beads** also absorb and scatter, attenuating the whole upper hemisphere. The shell signature then reduces to roughly the near hemisphere, and the Archimedes identity fails. Confirm the bead material (Part E).

**Near-interface emission (textbook; not in the cited sources).** A dipole 10–30 nm from a higher-index surface emits preferentially into the denser medium (Lukosz–Kunz theory; Chew for spheres). Surface PE and PE in solution may then be collected with different efficiencies. That undermines "κ cancels" in the solution reference. The magnitude for relative index 1.2 is not estimated here (Part E).

---

### B.2 PSF and optical-section model

#### B.2.1 Formulas

- **Mean wavelength** [S10]: $\bar\lambda=\sqrt2\lambda_{ex}\lambda_{em}/\sqrt{\lambda_{ex}^2+\lambda_{em}^2}=0.568$ µm.
- **Lateral FWHM:** $0.37\bar\lambda/\text{NA}$ at ≤ 0.25 AU; $\approx0.51\lambda_{ex}/\text{NA}$ at ≥ 1 AU [S10].
- **Axial FWHM, wave-optical limit** (< 0.25 AU) [S10]: $\text{FWHM}_z=0.64\bar\lambda/(n-\sqrt{n^2-\text{NA}^2})$. The prefactor is about 0.7 for a fluorescent plane [S10].
- **Axial FWHM, ≥ 1 AU** [S10]:
  $$\boxed{\text{FWHM}_z=\sqrt{\left(\frac{0.88\lambda_{em}}{n-\sqrt{n^2-\text{NA}^2}}\right)^2+\left(\frac{\sqrt2\,n\,PH}{\text{NA}}\right)^2}},\qquad PH=\text{AU}\times\frac{1.22\lambda_{em}}{\text{NA}}$$
  with n = 1.33. Spherical aberration is neglected, so these are lower bounds.

**Pinhole.**
- 1 AU in the intermediate image is 15.6 µm (10x/0.45), 18.7 µm (20x/0.75) and 17.5 µm (20x/0.80). The relay magnification to the AX pinhole plane is not published.
- The AX pinhole is a continuously variable 6-blade iris [S5]. Facility documents give about 6–153 µm with 0.7 and 1.0 AU presets.
- **The largest AU per objective must be read from NIS-Elements** before relying on 3–4 AU at 10x (Part E).

#### B.2.2 Numbers (derived; 561/575 nm)

| Objective | 1 AU, object side (µm) | FWHM$_{xy}$ ≥ 1 AU, 561/488 (µm) | FWHM$_{xy}$ ≤ 0.25 AU | FWHM$_z$ wave limit, water | FWHM$_z$ 1 AU, n=1 / **water** / repo | 2 AU, n=1 / **water** | 4 AU, n=1 / **water** |
|---|---|---|---|---|---|---|---|
| 10x/0.45 | 1.56 | 0.636 / 0.553 | 0.467 | 4.6 | 6.8 / **9.2** / 7.1 | 10.9 / **14.5** | 20.2 / **26.9** |
| 20x/0.75 | 0.94 | 0.381 / 0.332 | 0.280 | 1.6 | 2.3 / **3.2** / 2.6 | 3.8 / **5.2** | 7.2 / **9.6** |
| 20x/0.80 | 0.88 | 0.358 / 0.311 | 0.263 | 1.4 | 2.0 / **2.8** / 2.3 | 3.4 / **4.5** | 6.3 / **8.5** |

The n = 1 values match [S10, S11]. 10x is thick (≈ 7–9 µm at 1 AU); 20x is thin (2.3–3.2 µm).

#### B.2.3 Axial weight $w(z)$: tails matter (revised; `report_calcs/tails.py`)

$h=h_{xy}(x,y)\,w(z)$ with $w(0)=1$, so an in-focus flat sheet images as exactly $\sigma_s$.
- $\ell_{eff}=\int w\,dz$ over the whole solution.
- $T=\int_{-R}^{R}w\,dz/\ell_{eff}$ is the fraction of the section that falls inside the bead.
- The separable form is used only for the lateral blur. The integrated results need only the plane-integrated $w$.

The table gives values for G / R (repo) / L, all at 1 AU in water:

| Objective | $\ell_{eff}$ (µm) | $w(4\,\mu$m) | $T$ | Solution background (PE/µm² per nM) | Excluded-volume over-subtraction Δσ_s (PE/µm² per nM) |
|---|---|---|---|---|---|
| 10x/0.45 | 9.8 / 10.8 / 14.4 | 0.59 / 0.44 / 0.57 | 0.69 / 0.56 / 0.46 | 5.9 / 6.5 / 8.7 | 0.86 / 0.89 / 0.86 |
| 20x/0.75 | 3.4 / 3.9 / 5.0 | 0.013 / 0.086 / 0.14 | 0.997 / 0.82 / 0.76 | 2.05 / 2.4 / 3.0 | 1.07 / 1.03 / 0.99 |
| 20x/0.80 | 3.0 / 3.4 / 4.4 | 0.003 / 0.067 / 0.11 | 0.999 / 0.84 / 0.79 | 1.8 / 2.1 / 2.65 | 1.10 / 1.05 / 1.01 |

**Geometric-optics tail estimate** (derived). Far from focus, a sheet's emission spreads over a disc of radius $z\tan\theta$, and the pinhole of object-side radius $\rho_{PH}$ passes a fraction $w\approx(\rho_{PH}/z\tan\theta)^2$, with $\sin\theta=\text{NA}/1.33$.
- At 20x/0.80: $w(4\,\mu\text{m})\approx0.02$ and $T\approx0.95$.
- At 20x/0.75: $w(4)\approx0.03$ and $T\approx0.94$.

The repo model's tail is heavier (coefficient 1.14 vs 0.34 µm²), because its Gaussian-beam divergence underestimates the marginal-ray angle. Aberrations from a dry lens focusing into water add tail. **Best estimate at 20x/0.80: $w(4)\approx0.02$–0.07 and $T\approx0.84$–0.95. Measure it (Exp. 4).**

**What depends on the tails:**
- the plateau value of F;
- the solution background per nM;
- the absolute calibration (through $T$);
- how much glass-adsorbed PE at the coverslip ($z=-R$) leaks in (weight $w(4)$, 0.3–11%);
- ring contrast (§B.3.3).

---

### B.3 Analytic ring profile

#### B.3.1 Image equation

With the focal plane at $z_0$ relative to the bead centre, project first and blur second:
$$I(x,y;z_0)=\big[P_{z_0}*h_{xy}\big](x,y),\qquad P_{z_0}(\rho)=\sigma_s\frac{R}{\sqrt{R^2-\rho^2}}\Big[w\big(z_0-\sqrt{R^2-\rho^2}\big)+w\big(z_0+\sqrt{R^2-\rho^2}\big)\Big]$$

The separable form ignores the extra lateral spread of defocused light. The repo's non-separable PSF includes it; it matters for peak values, not for F.

#### B.3.2 The rim singularity

$P$ diverges as $(R-\rho)^{-1/2}$ but is integrable. Blur turns it into a peak of about $\sigma_s\sqrt{R/\sigma_{xy}}$. For numerical work, sample the shell area-uniformly ($z\sim U(-R,R)$) and histogram onto a grid with spacing ≤ 0.01–0.02 µm. Evaluating $P$ on grid points under-reads the peak by about 20%.

#### B.3.3 Peak, ring, centre and F versus focal offset

Index-matched bead, units of $\sigma_s$, fine sampling. Values in **20x/0.80, 1 AU** rows are G / L / R.

| $z_0$ (µm) | Rim peak | Peak drop | Ring radius (µm) | Centre | **F/F(0)** | Core F/F(0) (G) |
|---|---|---|---|---|---|---|
| 0 | 5.74 / 5.59 / — | — | 3.93 | 0.006 / 0.22 / 0.13 | **1** | 1 |
| 0.5 | | 5 / 3 / 2% | 3.91 | | **0.999 / 0.996 / 0.997** | 0.983 |
| 1 | | 18 / 14 / 12% | 3.91 | 0.04 (G) | **0.995 / 0.985 / 0.988** | 0.933 |
| 2 | | 54 / 45 / 40% | 3.81 | 0.25 (G) | **0.954 / 0.932 / 0.945** | 0.739 |
| 3 | | 75 / 70 / 61% | 3.2 | 0.71 (G) | **0.800 / 0.808 / 0.828** | 0.466 |

Other settings:

| Setting | Peak at $z_0$=0 | Peak drop at 1 / 2 µm | F/F(0) at 1 / 2 µm | ±5% plateau of F |
|---|---|---|---|---|
| 20x/0.75, 1 AU | 5.80 (G), 5.63 (L) | 12–16% / 40–48% | 0.984–0.989 / 0.927–0.939 | ±1.70–1.84 µm |
| 20x/0.80, 1 AU | as above | 12–18% / 40–54% | 0.985–0.995 / 0.932–0.954 | ±1.76–2.06 µm |
| 10x/0.45, 1 AU | 5.36 (G), 5.26 (L) | 3–8% / 11–21% | 0.977–0.981 / 0.912–0.927 | ±1.50–1.65 µm |
| 10x/0.45, 2 AU (G) | 5.52 | 1% / 5% | 0.989 / 0.955 | — |
| 20x/0.80, 2 AU (G) | 6.66 | 10% / 35% | 0.972 / 0.883 | — |

**Findings:**
1. **The rim is about 5–6× brighter than a flat sheet**, at both objectives.
2. **The ring stays pinned near R.** At 20x it moves inward only beyond $|z_0|\approx2.5$ µm. Ring radius is a poor focus estimator; **rim peak is a sensitive one**, at 12–18% per µm at 20x.
   - The repo's 20-pixels-per-bead table quotes a 30% peak drop at 2 µm. Coarse pixels and smoothing of the radial profile blunt the peak, which is a further reason not to quantify with it.
3. **Ring contrast depends on the tails.** At 20x/0.80, 1 AU, the centre at focus is $2\sigma_sw(R)$. The peak/centre ratio is about 900 (G), 135 (geometric tail), 40 (R) or 25 (L). It is about 15 in the repo gallery at 20 pixels per bead, and 4.5–6 at 10x.
   - **The centre value of an in-focus 20x bead is therefore a direct, free measurement of $w(R)$.** Use it to choose between tail models (Exp. 5).
4. **Shell/core discrimination at 20x.** A 1 µm offset costs a shell 0.5–1.5% and a core 6.7%. At 10x the two are indistinguishable.
5. **Opening the pinhole at 20x** raises the peak but narrows the plateau, and raises the solution background roughly in proportion to $\ell_{eff}$.
6. **All of the above assumes an index-matched bead** (§B.1.4).

#### B.3.4 Integrated intensity: Archimedes' theorem

A sphere has equal area per unit height ($dA=2\pi R\,dz$), so for an index-matched, non-absorbing bead:
$$\boxed{F(z_0)=2\pi R\,\sigma_s\int_{-R}^{R}w(z-z_0)\,dz}\qquad\text{vs}\qquad F_{core}(z_0)=c\int_{-R}^{R}\pi(R^2-z^2)\,w(z-z_0)\,dz$$

| Regime | Behaviour of F | Example |
|---|---|---|
| **Thin section** | Plateau $F=2\pi R\sigma_s\ell_{eff}T$ | 20x/0.80, 1 AU: within 5% for $|z_0|\le$ 1.76–2.06 µm |
| **Section ≈ bead diameter** | Stationary at the equator but visibly curved, with $T$ only 0.46–0.69. **The least tolerant case.** | 10x, 1 AU: within 5% for $|z_0|\lesssim$ 1.5–1.65 µm |
| **Very thick section** | $F\to4\pi R^2\sigma_sw(z_0)$; flat for $|z_0|\lesssim0.14\,\text{FWHM}_z$ | 10x, 4 AU: about ±4–4.5 µm (repo), if the iris reaches 4 AU |

> **Correction to a common rule of thumb.** "Integrated intensity is focus-invariant once the section is at least the bead diameter" is wrong for a section about equal to the bead diameter. It holds only for sections several times the bead diameter. This agrees with the corrected reading of [S12].

**Calibration identities (derived):**
1. **Thin-section plateau:** $\sigma_s=F/(2\pi R\,\ell_{eff}T)$, in sheet units.
2. **z-integral, any PSF:** $\int F(z_0)\,dz_0=4\pi R^2\sigma_s\,\ell_{eff}$ exactly. A finite stack over ±Z misses about $2a^2/Z$ of $\ell_{eff}$ for a $1/z^2$ tail $a^2/z^2$. That is 1–4% at Z = 15 µm; use Z ≥ 15–20 µm or fit the tail.

**Solution reference, corrected.** A uniform PE-antibody solution of known concentration $c$ (from A₅₆₅), imaged deep in solution with both tails in liquid, gives per unit area $S_{sol}=\kappa\,c\,\ell_{eff}$. A bead under the same settings gives $F=\kappa\,2\pi R\,\sigma_s\,\ell_{eff}T$. So
$$\boxed{\sigma_s=\frac{c\,F}{2\pi R\,S_{sol}\,T}}$$
- $\kappa$ and $\ell_{eff}$ cancel; **$T$ does not.** $T$ = 0.999 (G), ≈ 0.95 (geometric), 0.84 (R) or 0.79 (L) at 20x/0.80, so omitting it biases the result low by up to 21%.
- If the reference is imaged 4 µm above the glass, the solution integral runs from $-4$ µm upward and the factor becomes $\int_{-R}^{R}w/\int_{-R}^{\infty}w$ (0.88 for L).
- At 10x use the z-integral: $\sigma_s=c\int F\,dz_0/(4\pi R^2S_{sol})$, which needs no $T$.

**Measuring $w$ with the same solution (derived).** Scan the focus through the coverslip/solution interface, from 10 µm inside the glass to 30 µm into the solution. The signal is $S(h)=\kappa c\int_{-h}^{\infty}w$, so **its derivative is the sheet response $w(z)$** and its plateau is $\kappa c\ell_{eff}$. $T$ follows directly. A flat PE-layer coverslip gives the same information (Exp. 4).

**Assumptions behind the solution reference:**
- surface PE is as bright as PE in solution: no quenching, no density effect (§A.5), no change in near-interface emission (§B.1.4);
- glass-adsorbed PE is excluded by passivation;
- the bead is index-matched, or a bead-optics factor has been measured (§B.1.4).

For a polystyrene bead the bead-optics factor (≈ 0.6 or lower) dominates. **Cross-check absolute PE per bead by flow cytometry with PE-quantitation beads** (Exp. 10).

---

### B.4 Photon budget

#### B.4.1 PE inputs

| Input | Value | Status |
|---|---|---|
| Cross-section at 561 nm | $\approx7.3\times10^{-15}$ cm² | textbook (ε ≈ 1.9e6) |
| Absorption at 488 nm | ≈ 50–75% of 561 nm | assumption [S15] |
| Q, $\tau_{fl}$ | 0.82, 2.7 ns | textbook |
| $I_{sat}$ | ≈ 5e22 cm⁻²s⁻¹ | consistent with [S9] |

561 nm excites PEB-560, the group linked to both the dark state and photodegradation [S15].

#### B.4.2 Laser power, irradiance and the saturation threshold (revised)

At 561 nm, 1 µW = $2.82\times10^{12}$ photons/s. Peak irradiance is $I_0=\Phi/A_{eff}$ with $A_{eff}=\pi\,\text{FWHM}_{xy}^2/4\ln2$ (Gaussian peak).

**Signal saturation with confocal weighting** (derived). For a sheet in focus, with Gaussian excitation of peak $k_0$ and detection weighting of width $s_d$:
$$\frac{\text{signal}}{\text{linear}}\approx1-\beta k_0,\qquad\beta=\frac{1/2s^2+1/2s_d^2}{1/s^2+1/2s_d^2}$$
- $\beta=0.5$ with no detection weighting (wide-field);
- $\beta=2/3$ when $s_d=s$;
- $\beta\approx0.6$ at 1 AU ($s_d\approx1.4s$).

A 5% sublinearity therefore occurs at $k_0\approx0.075$–0.083, not at 0.1.

| Objective | $A_{eff}$ (µm²) | $I_0$ per µW (cm⁻²s⁻¹) | P for $k_0=1$ | **P for 5% sublinearity** |
|---|---|---|---|---|
| 10x/0.45 | 0.458 | 6.2e20 | 83 µW | **6.2–6.9 µW** |
| 20x/0.75 | 0.164 | 1.7e21 | 30 µW | **2.3–2.5 µW** |
| 20x/0.80 | 0.145 | 1.9e21 | 26 µW | **2.0–2.2 µW** |

- These assume an aberration-free focus and textbook σ and τ (±30%), so measure them (Exp. 7).
- The R-PE ms dark state adds further sublinearity [S15].
- A "1–5% of max laser" starting point [S6] can exceed this. At the same %, the 20x passes up to about 0.7× the 10x power [S6, corrected reading].
- The repo simulator's 10 µW headline sits at $k_0\approx0.4$, well into the sublinear regime.

#### B.4.3 Detection efficiency (assumption chain, about ±2×)

$$\eta_{det}=\tfrac{1-\cos\theta}{2}\Big|_{\sin\theta=\text{NA}/1.33}\times T_{obj}(0.85)\times T_{band}(0.55)\times T_{PH}(0.8)\times T_{optics}(0.8)\times QE_{GaAsP}(0.42)$$

| Objective | $\eta_{det}$ |
|---|---|
| 10x/0.45 | ≈ 0.37% |
| 20x/0.75 | ≈ 1.1% |
| 20x/0.80 | ≈ 1.3% |

- Objective transmittance is published only as a graph [S11].
- GaAsP QE is about 40–45% (textbook; Part E); multialkali PMTs are 10–20% [S12].
- With 561 nm excitation the emission band must start at about 570–575 nm, which clips the PE peak [S5].
- A bead that is not index-matched multiplies $\eta$ by its bead-optics factor (§B.1.4).

#### B.4.4 Photons per pixel

For an in-focus flat sheet in the linear regime:
$$N_{sheet}=\eta_{det}\,Q\,\sigma_{abs}\,\sigma_s\,\Phi\,\tau_{dwell}$$
This is **0.0062 (10x), 0.018 (20x/0.75) and 0.021 (20x/0.80)** photons per (PE µm⁻²)(µW)(µs). A rim pixel collects about 5.4–5.8 × $N_{sheet}$ when finely sampled (≈ 5 × at 0.43 µm pixels).

**Recommended 20x/0.80 setting (2 µW, 2 µs, 0.43 µm pixels):**
- rim pixel ≈ 0.4–0.5 $\sigma_s$ photons;
- whole bead ≈ 35–41 $\sigma_s$ photons per frame (repo: 41), i.e. ≈ 0.2 photons per PE per frame.

At 1 pM (σ_s ≈ 2.5, N_PE ≈ 500) that is about 100 photons per bead but only about 1 photon in the brightest pixel. **The PE ring is invisible at the low end** (§D.1 item 4).

**Detector linearity at the top** (assumption). At σ_s ≈ 1,500, a rim pixel collects about 600–700 photoelectrons in 2 µs (≈ 3×10⁸ s⁻¹). Analog GaAsP anode-current nonlinearity or overload protection may set in. Map linearity with an ND-filter ladder (Exp. 2 extension) and lower the HV on top standards.

#### B.4.5 Detected photons per bleaching dose

In the linear regime every PE receives the same dose per frame (§B.5.1), so
$$\frac{N_{bead}}{4\pi R^2\sigma_sD_f}=\frac{\eta_{det}QF}{4\pi R^2}\approx0.0026\ (10x),\ 0.0038\ (20x/0.75),\ 0.0039\ (20x/0.80)$$
This is for Gaussian $w$ and an index-matched bead. With heavier tails, $F$ per $\sigma_s$ rises roughly in proportion to $\ell_{eff}T$, by up to about 15%.

- Each PE yields at most about **230 (10x) to 350 (20x)** detected photons over its life. A 5% bleach budget leaves 12–18 photons per PE.
- Photon-limited CV ≈ $\sqrt{\text{ENF}/(N_{PE}n_{det})}$: ≈ 1% at 1,000 PE per bead (Poisson CV of the bound count 3.2%), ≈ 3% at 100 PE (10%).

**Optical LOD per bead at the recommended operating point** (repo PSF; `report_calcs/lod.py`):
- Recipe: 3 × the shot-noise SD of a blank bead, integrated metric, 20 pixels per bead, 2 µs dwell.
- The "washed" column depends on the repo's assumed read noise (3 DN at 20 DN per photoelectron).

| Setting, laser at sample | Washed | Free PE-Ab 0.1 nM | 1 nM | 10 nM |
|---|---|---|---|---|
| 20x/0.75 or 0.80, 1 AU, **10 µW** (repo headline; sublinear) | 16 | 36–37 | 104–106 | 326–331 |
| 20x/0.75 or 0.80, 1 AU, **2 µW** (recommended) | 64–66 | 91–93 | 214–220 | 649–666 |
| 10x, 1 AU, 2 µW | 98 | 136 | 311 | 938 |
| 10x, 4 AU, 2 µW | 65 | 125 | 344 | 1,070 |

**Per-well LOD.** These are per-bead limits. The per-well mean of 100 beads is about 10× lower: ≈ 6 PE per bead washed, or 21 PE per bead at 1 nM no-wash. In the reference case (≈ 500 PE per bead per pM at 1 h) that is ≈ 0.01–0.05 pM. None of these include non-specific binding.

**With non-specific binding** (derived, parametric):
$$\text{LOD}_{well}\approx3\sqrt{\frac{\text{SD}_{bead}^2}{n}+(c_{well}N_{SD})^2}$$
- Here $N_{SD}$ is the mean non-specific PE per bead and $c_{well}$ its well-to-well CV.
- Example (assumption): $N_{SD}=1{,}000$ PE per bead (5 PE/µm²) with $c_{well}=10\%$ gives LOD ≈ 300 PE per bead ≈ 0.6 pM. That is about 10–50× the optical limit.
- **NSB, not optics, sets the LOD.** It is unmeasured (Exp. 9, Part E).

#### B.4.6 Background from free PE-detection antibody (unwashed)

**Solution background.** A uniform concentration $c$ images as a sheet of $\sigma_{bg}=c\,\ell_{eff}$. At 1 nM (0.602 µm⁻³) that is **5.9–8.7 (10x), 2.05–3.0 (20x/0.75) and 1.8–2.65 (20x/0.80) PE µm⁻²** in every pixel. Its shot noise cannot be subtracted away [S12].

**Excluded volume** [S12, corrected reading]. The bead displaces solution, so subtracting the annulus value over-subtracts by
$$\Delta\sigma_s=\frac{cV_w}{2\pi R\int_{-R}^{R}w},\qquad V_w=\int_{bead}w\,dV$$
That is ≈ 0.86–0.89 (10x), 0.99–1.07 (20x/0.75) and 1.01–1.10 (20x/0.80) PE µm⁻² per nM (derived).

**Implementation in image units.** Let $B_{ann}$ be the annulus background per pixel (DN, offset removed) and $B_0$ the same quantity in a buffer-only well. Then
$$F_{corr}=\sum_{\rho<R+1.5\,\mu m}(DN-\text{offset}-B_{ann})\,p^2+(B_{ann}-B_0)\frac{V_w}{\ell_{eff}}$$
The units are DN·µm², and the term vanishes when $c=0$. The alternative is to wash or dilute.

**Other backgrounds.**
- Glass-adsorbed PE contributes $\sigma_g\,w(R)$ (0.3–11% of $\sigma_g$ at 20x). It is uniform, so the annulus removes it, except in a solution reference well (passivate).
- Bead autofluorescence is unmeasured. Measure it on capture-only beads.

#### B.4.7 Detector and electronics

- **Shot noise:** $N_{pe}\sim\text{Poisson}(N_s+N_b+N_d)$. Convert counts to photoelectrons by photon transfer at each HV [S12].
- **PMT gain** scales signal and noise together. ENF = $s_e^2$ ≈ 1.2–1.56 [S10, S12].
- **SNR:**
  $$\text{SNR}=\frac{N}{\sqrt{\text{ENF}(N+N_b+N_d)+q^2N^2+\sigma_{read}^2/g^2}}$$
  Laser noise dominates above $N\approx\text{ENF}/q^2$. The corrected [S10] example gives ≈ 15.6, not 25.1.
- **ADC:** 12-bit (0–4095) by default; 16-bit only with fine integration, and samples can clip before summation [S5]. Allow no saturated or zero-clipped pixels [S6, S12].
- **Scan modes** [S5]:
  - galvano: minimum dwell 0.2 µs; up to 8192²;
  - resonant: ~20–32 ns effective dwell at 2K. It needs integration, and its dwell varies sinusoidally across the line.
- **Averaging vs dwell:** equal SNR at equal total dose [S10, corrected reading].
- **Drift:**
  - laser power: 10–25% over 3 h on older systems, about 3% per 2 h on warmed solid-state lasers;
  - focus: about 0.5 µm per 5 min [S6, corrected reading].
- **NSPARC** (if fitted): photon counting; its resolution figures do not apply to 10x/20x [S5].

---

### B.5 Photobleaching

#### B.5.1 Dose per frame is uniform through the bead

In one-photon excitation every plane carries the full beam power. A raster of pitch $p$ therefore delivers the same fluence to every molecule:
$$D_f=\sigma_{abs}\frac{\Phi\tau n_{avg}}{p^2}\,f_{sat},\qquad f_{sat}=\frac{\ln(1+k_0)}{k_0}\ \text{(in-focus plane, Gaussian beam; derived)},\qquad S_f=e^{-\phi_dD_f}$$
$f_{sat}\to1$ for out-of-focus molecules and at low power.

| Settings | $D_f$ (absorptions/frame) | Lost per frame |
|---|---|---|
| 20x, 2 µW, 2 µs, 0.20 µm pixel | 205 | 0.23% |
| 20x, 2 µW, 2 µs, 0.43 µm pixel | 44 | 0.05% |
| 20x, 2 µW, 1 µs, 0.43 µm pixel | 22 | 0.02% |
| 10x, 5 µW, 2 µs, 0.32 µm pixel | 200 | 0.22% |

**Focus in transmitted light** [S12].

**Rates and modifiers:**
- R-PE $\phi_d=1.1\times10^{-5}$: the least photostable phycobiliprotein tested, about 2.5× better than fluorescein [S3]. PE is listed among dyes that bleach rapidly [S6].
- n-Propyl gallate: 1.7× better [S3].
- Oxygen removal and ROS scavengers: no effect [S3].
- DTT: the sources conflict [S3 vs S15].

#### B.5.2 Beyond first order

- **Saturation:** in-focus molecules absorb sublinearly (factor $f_{sat}$).
- **Dark state:** reversible, ms [S15]. Model it as $B\xrightarrow{\phi_Dk_{abs}}D\xrightarrow{k_{rec}\sim10^2\text{–}10^3\,s^{-1}}B$ plus $B\xrightarrow{\phi_dk_{abs}}X$, and fit $\phi_D$ from repeated frames with variable delay.
- **Density dependence:** possible cooperative bleaching through energy traps at high σ_s (§A.5).

#### B.5.3 How bleaching biases each metric

- **Single plane, linear regime:** bleaching is a pure gain error. Fix the number of frames and the power.
- **z-series:** slice $k$ is scaled by $S_f^{k-1}$.

> **Correction.** Rim pixels are *not* bleached faster in a z-series, because dose per molecule is uniform. They hold more molecules per pixel.

---

### B.6 Sampling, pixels per bead, field position and bead detection

#### B.6.1 Pixel size on the AX-R

FN 25 is the scan-field diagonal, so the square side at zoom 1 is $25/(\sqrt2M)$: 1.77 mm at 10x and 0.88 mm at 20x [S5, corrected reading]. Pixel size is $p=17.7\text{ mm}/(M\cdot\text{zoom}\cdot N_{px})$.

| Zoom 1 | 1024² | 2048² | 4096² | 8192² |
|---|---|---|---|---|
| 10x: pixel (µm) / pixels per bead | 1.73 / 4.6 | 0.86 / 9.3 | 0.43 / 18.5 | 0.22 / 37 |
| 20x | 0.86 / 9.3 | 0.43 / 18.5 | 0.22 / 37 | 0.11 / 74 |

Galvano frame time ≈ $N^2\tau$ plus flyback. At 2048²: 4.2 s (1 µs), 8.4 s (2 µs).

**Beads per field** (derived; assumes the whole reaction settles in a 96-well with ≈ 32 mm² of bottom area):
- $10^4$ beads gives ≈ 300 beads/mm²;
- ≈ 240 beads per 20x field (0.78 mm²) and ≈ 950 per 10x field;
- mean spacing ≈ 57 µm.

**One 20x field per well therefore gives ≥ 100 analysable beads.** Use 2 fields only when transferring an aliquot.

#### B.6.2 Nyquist

- **Rim peak:** ≥ 25 pixels per bead (10x) and ≥ 42–45 (20x) [S10]; 2.3–3 pixels per FWHM in practice [S6, S10].
- **Integrated intensity:** structure-size sampling is acceptable [S6, corrected reading].

#### B.6.3 Sub-pixel bead offset (derived; 300 random offsets; $z_0=0$; 1 AU)

| Pixels per bead | 10x: peak mean (SD) | 10x: F CV | 20x/0.8: peak mean (SD) | 20x/0.8: F CV |
|---|---|---|---|---|
| 4 | 0.82 (0.09) | 0.66% | 0.57 (0.17) | 8.6% |
| 8 | 0.94 (0.04) | 0.03% | 0.85 (0.07) | 1.9% |
| 12 | 0.96 (0.02) | <0.01% | 0.92 (0.04) | 0.54% |
| 16 | 0.975 (0.008) | ~0 | 0.95 (0.02) | 0.21% |
| 25 | 0.985 (0.006) | ~0 | 0.97 (0.009) | ~0 |
| 40 | 0.993 (0.003) | ~0 | 0.98 (0.006) | ~0 |

The repo gives an integrated swing of 2.7% at 8 pixels per bead, 1.4% at 12, 0.13% at 20, against 5–34% for the peak. **12–16 pixels per bead are enough for F.**

#### B.6.4 Field position

- **Illumination fall-off:** ≥ 10% from corner to centre, and up to 40–60% [S6]. Acquire a flat field every session on the AX-R with matched settings [S12, corrected reading].
- **Field curvature:** not published [S11]. Model it as $\delta z(r)=\kappa r^2$ and measure it.
- **Spacing:** keep bead centres ≳ 10 µm apart.

#### B.6.5 Bead detection and per-bead focus (new)

**The problem.** Segmenting beads on the PE channel selects bright beads at the low end and biases the low standards upward. Below σ_s ≈ 10 PE/µm² the ring is at most a few photons per pixel.

**The fix:**
- Segment on a transmitted-light channel acquired with the scan. The AX-R can carry a transmitted-light detector; confirm it is fitted (Part E). That costs no extra PE dose.
- Fit the bead centre and $R$ from the transmitted image, so every bead, including zero-signal beads, is counted.
- **Focus flag.**
  - Use the transmitted-light bead-edge appearance, calibrated against z in Exp. 5.
  - Use the PE peak/F ratio only above a minimum count. A 15% threshold needs ≥ ~200 photoelectrons in the rim peak, i.e. $\sigma_s\gtrsim400$–500 PE/µm² at 2 µW, 2 µs.
  - Reject beads more than about 15% below the field-median peak/F ($|z_0|\gtrsim1$ µm).
- **Simulation check:** the per-bead detection probability vs σ_s for each segmentation route (§C.1).

---

### B.7 Simulation recipe (pseudo-code; corrected)

```
INPUTS
  objective ∈ {10x/0.45, 20x/0.75, 20x/0.80}; λex (561|488), λem=575 nm; n=1.33
  pinhole_AU; P_sample_µW (measured); HV gain g (counts/pe, photon transfer); offset
  σ_s (PE/µm²) [Part A]; bead radius R_i (size CV); bead index n_b, absorbing flag
  c_free (nM); φ_d, φ_D, k_rec; ENF; q; σ_read; dark rate
  pixel p (µm) or (zoom, N_px); dwell τ; n_avg; scan mode (galvano|resonant)
  z0 (sample µm) [or z-list]; bead xy offset (sub-pixel + field position r)
  flatfield(r), field curvature κ; bit depth (4095 | 65535)
  w-model ∈ {G, L, repo wave-optical, measured}

SETUP
  FWHM_xy, FWHM_z ← §B.2 (water); σ_xy; w(z) from chosen model
  ℓ_eff = ∫w (whole solution); T = ∫_{-R}^{R} w / ℓ_eff; V_w = ∫_bead w dV
  shell points: z_i ~ U(-R,R), φ_i ~ U(0,2π)  (area-uniform; N ≳ 1e6)
  weight a_i = σ_s·4πR²/N ; survival s_i = 1 ; dark d_i = 0
  optics factor c_i = c(z_i) from ray trace if bead not index-matched (§B.1.4), else 1
  bead centre = field position + sub-pixel offset; local z0' = z0 + κ r²
  FF(r); background σ_bg(x,y) = c_free·∫_solution w dz (bead volume excluded)
  k0 = σ_abs·Φ(P)·τ_f / A_eff  (peak excitation parameter)

FOR each frame / slice k:
  1. W_i = w(z_i − z0'_k);  k_i = k0·(local in-plane factor; →0 out of focus)
  2. H = hist2d(x_i,y_i; a_i·s_i·(1−d_i)·c_i·W_i·(1 − β·k_i)) on grid dx ≤ 0.02 µm
       (β ≈ 0.6–0.67 at 0.5–1 AU; 0.5 for a fully open pinhole)
  3. B = H * h_xy(z-dependent if non-separable PSF) (FFT) + σ_bg
  4. galvano: box-average B along x over p, point-sample y at pixel centres
  5. μ_pix = η_det·Q·σ_abs·Φ(P)·τ·n_avg·FF(r)·B_pix
  6. D_i = σ_abs·Φ·τ·n_avg/p² · f_sat(k_i),  f_sat(k) = ln(1+k)/k  (→1 as k→0)
     s_i ← s_i·exp(−φ_d·D_i);  d_i ← 3-state update (φ_D, k_rec, line period)
  7. n_pe ~ Poisson(μ_pix + μ_dark)
  8. M ~ Gamma(shape=n_pe/(ENF−1), scale=ENF−1) × (1 + q·N(0,1))
  9. DN = clip(round(offset + g·M + σ_read·N(0,1)), 0, 4095|65535)
  (optional) transmitted-light image of the bead for segmentation and focus

ANALYSIS (per bead)
  centre and R_i from transmitted-light fit (or ring fit if bright)
  peak; ring mean (±0.5 µm annulus); peak/F (focus flag, only if peak ≥ ~200 pe)
  B_ann = median annulus (DN − offset); B_0 = same in buffer-only well
  F = Σ_{ρ<R+1.5µm}(DN − offset − B_ann)·p² + (B_ann − B_0)·V_w/ℓ_eff    [DN·µm²]
  σ̂_s = F/(g·η_det·Q·σ_abs·Φ·τ·2πR·ℓ_eff·T)   or   c·F/(2πR·S_sol·T)
  N̂_PE = 4πR_i²·σ̂_s
  SNR per metric; bias σ̂_s/σ_s − 1; bleached fraction 1 − ⟨s_i⟩; detected (yes/no)
```

**Sanity checks and unit tests:**
- (a) F is linear in σ_s for $k_0\ll1$; the 5% bend falls at $k_0\approx0.08$.
- (b) Bleached fraction ∝ $P\tau$ at low $k_0$, and is non-zero at any P > 0.
- (c) The excluded-volume term vanishes when $c_{free}=0$.
- (d) F(z₀) matches §B.3.4 for an index-matched bead; thick limit $F=4\pi R^2\sigma_sw(z_0)$; a core bead gives $F\propto R^2-z_0^2$.
- (e) Centre = $2\sigma_sw(R)$ at $z_0=0$.
- (f) F is invariant to sub-pixel offset on average.
- (g) Photon transfer: var(DN) ≈ g·ENF·mean.
- (h) $\int F\,dz_0=4\pi R^2\sigma_s\ell_{eff}$ over a long stack.
- (i) The experimental anchors of Part C reproduce.

### B.8 Parameter table

| Parameter | Value / range | Source | Status |
|---|---|---|---|
| R | 4 µm; size CV 2–5% | given; CoA | measure CV |
| $\sigma_s$ | 0.1–5×10³ µm⁻² | Part A | derived |
| 10x | Plan Apo λD, NA 0.45, WD 4.0 mm, 0.17 mm coverglass | [S11] | established |
| 20x | λD NA 0.80 (a 20x/0.75 is a different model) | [S11] | **check the engraving** |
| Pinhole | 6-blade iris; ~6–153 µm; 0.7/1.0 AU presets | [S5] + facility documents | maximum AU per objective unknown |
| FWHM$_{xy}$, 1 AU | 0.64 / 0.38 / 0.36 µm | [S10] | derived |
| FWHM$_z$, 1 AU, water | 9.2 / 3.2 / 2.8 µm (repo 7.1 / 2.6 / 2.3) | [S10] | derived (lower bound) |
| $w(R)$, $T$ at 20x/0.80 | 0.003–0.11; 0.79–0.999 (best estimate 0.02–0.07; 0.84–0.95) | §B.2.3 | **measure** |
| Stage → sample z | ~1.33 | [S4] principle | measure |
| Dwell | galvano ≥ 0.2 µs; resonant ~20–32 ns | [S5] | established / derived |
| ADC | 12-bit default; 16-bit with integration | [S5] | established |
| Detector QE | GaAsP 0.40–0.45; MA 0.10–0.20 | [S12]; textbook | per channel |
| ENF | 1.2–1.56 | [S10, S12] | established |
| Laser noise q | 0.5–3% | [S6] | assumption |
| Field non-uniformity | ≥ 10% (up to 40–60%) | [S6] | measure |
| R-PE σ, Q, τ | 7.3e-15 cm², 0.82, 2.7 ns | textbook | assumption |
| $\phi_d$ | 1.1e-5 (6.5e-6 with n-propyl gallate) | [S3] | established |
| Bead index / material | unknown (PS 1.59? magnetic?) | — | **open; strong effect (§B.1.4)** |
| Imaging medium | water n = 1.33; a dried sucrose read has n ≈ 1.5 (assumption) | — | separate calibration |

**Sucrose-dried reads** [S1] change four things:
- the medium index, and with it $\ell_{eff}$, the z scaling and the bead index contrast. Polystyrene against ~1.5 is a *better* match;
- possibly PE brightness and photostability;
- the validity of the aqueous solution reference.

Dried reads therefore need dried standards and their own Exp. 4/5 calibration.

---

## Part C: Simulation plan

### C.1 Parameter sweep and interactions

**Baseline unless swept:** 20x/0.80, 1 AU, 561 nm, 2 µW at the sample, 2 µs galvano dwell, 18 pixels per bead, $z_0$ at the F stationary point, centred bead, σ_s = 100 PE/µm², one frame, washed, $\phi_d=1.1\times10^{-5}$, repo $w$ model, index-matched bead.

**One-at-a-time sweeps:**

| Parameter | Range | Step | Outputs most affected | Expected effect |
|---|---|---|---|---|
| **Pinhole** | 0.25–4 AU (check the maximum) | 0.25, 0.5, 0.7, 1, 1.5, 2, 3, 4 | FWHM$_z$, ℓ_eff, T, ring contrast, F(z₀), background | Opening raises signal and background ∝ ℓ_eff. The 20x plateau narrows above ~1.5 AU. At 10x, 3–4 AU reaches the thick limit (focus-tolerant) but loses shell/core discrimination. |
| **Laser power at sample** | 0.3–100 µW | log: 0.3, 1, 2, 3, 10, 30, 100 | Linearity, bleaching, SNR, dark state | Linear to ~2 µW (20x) or ~6–7 µW (10x). SNR ∝ √P until saturation. |
| **Detector gain (HV)** | top bead at 5–95% of full scale | ~50 V ladder | DN scale, clipping, read noise, anode linearity | No change in photon SNR. Too low: quantisation. Too high: clipping or anode nonlinearity. |
| **PE surface concentration** | 0.1–5,000 PE/µm² | half-decade | All metrics, LOD, detection probability | Linear until detector or ADC limits (or density quenching). Low end limited by NSB and background. |
| **Photobleaching** | $\phi_d$ ∈ {0, 6.5e-6, 1.1e-5, 2.2e-5}; frames 1–60; $\phi_D$ 0–1e-3; $k_{rec}$ 1e2–1e3 s⁻¹ | grid | Frame decay, z-skew, F bias | Gain error ∝ $\phi_dD_f$. The dark state gives recoverable dimming that depends on line rate. |
| **Pixels per bead** | 4–64 | 4, 6, 8, 12, 16, 25, 40, 64 | Peak bias, F CV, frame time | F is unbiased; CV < 1% above 12. The peak needs ~40. |
| **Dwell time** | 0.5–20 µs galvano; resonant 0.03 µs × 8–64 | 0.5, 1, 2, 4, 8, 20 µs | Photons, dose, frame time | Photons and dose both ∝ τ. Long dwell plus high power worsens the dark state. |
| **Focal-plane offset $z_0$** | −4 to +4 µm | 0.25 µm | Peak, F, ring radius, centre fill, peak/F | 20x F flat to ±1.8–2.1 µm (index-matched); peak −12–18% per µm. With bead optics F becomes asymmetric (§B.1.4). |
| **Bead offset from scan centre** | sub-pixel 0–1 px; field radius 0 to corner | 0.1 px; 5 radial steps | Peak scatter, F CV, flat-field factor, local $z_0$ | Sub-pixel affects only the peak. Field position gives ≥ 10% fall-off plus curvature defocus. |
| **Objective** | 10x/0.45, 20x/0.75, 20x/0.80 | categorical | Everything | 20x: thin section, plateau F, ≈ 1.5× photons per dose, ≈ 3× less background per nM, shell/core discrimination. 10x: 4× field, filled-disc image. |
| **Bead size CV** (new) | 0–8% | 0, 2, 5, 8% | Bead-to-bead CV of F, σ̂_s, N̂_PE | Adds 0–1× (20x) or 1–2× (10x) the size CV, depending on regime (§A.3). Removed by per-bead R correction. |
| **Bead index / absorption** (new) | n = 1.33, 1.45, 1.49, 1.59; absorbing core | categorical | F(z₀) shape, equatorial F, stationary point | Equatorial F × ~0.6–0.75; asymmetric focus curve (§B.1.4). |
| **Segmentation route** (new) | PE-ring vs transmitted light | categorical | Detection probability vs σ_s, low-standard bias | PE segmentation fails below ~10 PE/µm² and biases low standards upward. |

**Two-parameter interaction maps** (run these, not only one-at-a-time sweeps):
1. **pinhole × objective × $z_0$:** the focus-tolerance map of F and peak, under each $w$ model and bead index;
2. **power × dwell × frames (with the dark state):** linearity and bleach maps, at fixed dose and at fixed photons;
3. **pixel size × field size × plate time:** the beads-per-well vs minutes-per-plate frontier;
4. **$D_T$ × wash/no-wash × Λ:** LOD, upper range and timing error (needs NSB from Exp. 9).

**Optimisation target.** Use the **propagated concentration CV per well-minute**, evaluated at three points: the low standard (≈ 1 pM), mid-range (≈ 100 pM) and near the top of the working range. The chain is Part A → Part B → analysis:
$$\text{CV}_{A}=\frac{\sqrt{\big(c_v^2+\tfrac{1}{N_{PE}}+\tfrac{\text{ENF}(N_{ph}+N_b)}{N_{ph}^2}\big)/n_{beads}+c_{well,NSB}^2(N_{SD}/N)^2+(\Lambda\,\delta t)^2+\text{CV}_{n_b}^2}}{|d\ln N_{PE}/d\ln A_T|}$$

**First-pass numbers** (derived; 20x/0.80, 2 µW, washed, $c_v=0.15$ assumed, 100 beads):

| Analyte | Dwell | Photon-shot CV per bead | Total per bead | Per-well CV |
|---|---|---|---|---|
| 1 pM | 2 µs (≈ 100 photons) | 11% | 19% | 1.9% |
| 1 pM | 1 µs | 16% | 22% | 2.2% |
| 100 fM | 2 µs (≈ 10 photons) | — | — | 4.1% |
| 100 fM | 1 µs | — | — | 5.3% |

**So the low end gains from 2 µs; above ~1 pM, 1 µs halves the frame time at no real cost.** Timing error ($\Lambda\delta t$) and NSB variation are expected to dominate all of these, which is why §D.3 puts the plate timeline first.

**Output metrics per simulated bead:**
- F (corrected), ring mean, rim peak, ring radius, centre/peak, peak/F;
- $\hat\sigma_s$ and its bias, SNR and CV over noise realisations;
- bleached fraction, saturated or zero pixels;
- detected (yes/no);
- LOD (per bead and per well);
- beads per field, seconds per field.

### C.2 Validation experiments that pin each parameter

Numbering follows `PE_bead_confocal_experiments.md`. Items marked *(extension)* were added after this table was drafted; they are now in the plan and in the RM protocols.

| Parameter(s) pinned | Experiment | How | Acceptance / returns |
|---|---|---|---|
| µW at the sample vs % (each objective) | Exp. 1 | Slide power meter at the focus, 561 (and 488) nm, 5–6 settings | Linear map; 20x/10x ratio (expect ≲ 0.7 [S6]) |
| Gain g(HV), offset, read noise, ENF, **detector linearity** | Exp. 2 + Exp. 8 | Photon transfer on a uniform dye slide, 6–8 HV values. *(Extension)* ND-filter ladder at fixed HV up to top-standard photon rates. | var = g·ENF·(mean − offset) + read²; linearity to ≤ 2% |
| Flat field FF(r) | Exp. 3 | Uniform dye layer matched to PE, every session | Residual < 2% |
| PSF, **$w(z)$ and its tails**, ℓ_eff, **T**, z scale | Exp. 4 *(extended)* | 100–200 nm beads for the 3-D PSF. **z-scan of a flat PE-layer coverslip to ±20 µm**, and **z-scan of a PE solution through the glass/solution interface (−10 to +30 µm), whose derivative is $w$**. Reflection standard for the z scale. | FWHM$_z$ vs AU; tail coefficient; $T$; ℓ_eff |
| Shell model, F(z₀), ring radius, **bead optics** | Exp. 5 *(extended)* | z-series (0.25 µm, ±6 µm) through single beads at 1 and 2 AU, both objectives. Transmitted-light images at each z (focus calibration). Core bead control. *(Extension)* If available, the same beads in a higher-index medium, or same-size beads of a different material. | Plateau at 20x; **symmetry of F(z₀) about the equator**; stationary-point offset; centre/peak gives $w(R)$ |
| Pixels per bead, sub-pixel, field curvature κ | Exp. 6 | 6–64 pixels per bead; stage shifts of 0.1–0.5 px; bead grid with per-bead best focus | F CV vs pixels per bead; κ |
| φ_d, saturation, dark state, **density quenching** | Exp. 7 *(extended)* | (i) Bleach curves at 3 powers. (ii) Power series 0.3–100 µW at fixed dose. (iii) Dwell vs averages vs line rate with variable delay. *(Extension)* (iv) PE-D diluted with unlabelled D at fixed $D_T$, so PE density varies at fixed binding. | φ_d; P for 5% sublinearity (expect ≈ 2 µW at 20x); recoverable fraction; F linear in labelled fraction |
| Dwell linearity | Exp. 7 | 0.5–20 µs at fixed P | Signal ∝ τ |
| Free-PE background, autofluorescence, **NSB vs $D_T$** | Exp. 9 *(extended)* | Capture-only beads; beads + PE-Ab with no analyte **at $D_T$ = 0.5, 1, 2, 5 × $K_2$**, in ≥ 6 wells each; unwashed series 0.1–10 nM | $N_{SD}(D_T)$, its bead and well CV; LOD vs $D_T$; excluded-volume term |
| Absolute PE per bead | Exp. 10 *(extended)* | (a) Solution reference with the measured $T$. (b) PE-quantitation beads (check shell vs volume label and diameter). (c) Flat PE sheet of known density. *(Extension)* (d) **Flow cytometry of the same assay beads against PE-quantitation beads**, which also gives an independent bead-to-bead CV. | (a), (b) and (d) agree within ~15% once the bead-optics factor is applied |
| $n_{PE}$ | Exp. 10 | A₅₆₅/A₂₈₀; SEC | Mean PE per IgG |
| $k_{-2}$ (Λ) on beads; $k_{-1}$; active $N_S$; **temperature** | Exp. 11 | Post-wash time course (fresh beads per point) at logged temperature; relabel pulse; labelled analyte | Λ (sets the timing rule); $k_{-1}$ bound; $N_S$ |
| $K_1$, $K_2$, independence, hook | Exp. 12 | fM–µM curve; one-step vs two-step at long incubation | Route independence; hook vs §A.2.5 |
| Strategy check | Exp. 13 *(extended)* | Head-to-head: 20x/1 AU single plane, 10x/1 AU, 10x/4 AU, 20x z-sum, plus flow cytometry, on identical wells | Concentration CV per well-minute and LOD per mode |

### C.3 Reconciling the repo simulator with this report (action items)

1. **One parameter file.** `binding.py` defaults ($K_{D1}=1$ nM, $K_{D2}=10$ nM, 5,000 beads) differ from the Part A reference case. Put shared parameters in one file and regenerate `fig1_binding.png`.
2. **Operating point.** The repo LOD and photon-budget tables are at 10 µW ($k_0\approx0.35$–0.4, sublinear). Regenerate them at 2 µW (the values in §B.4.5 come from the repo code at 2 µW) and add an NSB term ($N_{SD}$, $c_{well}$).
3. **Fluorescence lifetime.** The repo uses $\tau_f=2.5$ ns and this report 2.7 ns. Choose one.
4. **Missing terms.** Add the dose and signal saturation factors of §B.7, the corrected excluded-volume term, bead-size CV, the bead-optics factor $c(z)$, and transmitted-light segmentation.
5. **Tables.** Add the G/L/repo tail comparison (§B.2.3) to `figures/tables.md`.

**Status, 2026-10-24.**
- **Done:**
  - item 1: [`params.py`](bead_confocal_sim/params.py) holds every shared number; `binding.py` defaults are the reference case and gain a separate D_AD; `fig1` was regenerated;
  - item 2: all figures and tables regenerated at 2 µW, and the LOD table now matches §B.4.5;
  - item 3: τ = 2.7 ns everywhere.
- **Done in the interactive engine only** (`interactive/src/confocal-engine.js`, not yet in `optics.py`):
  - point-by-point signal saturation;
  - the excluded-volume term for free PE;
  - the bead-optics factor c(z) from the ray trace, as an option.
- **Still open:** dose saturation, bead-size CV, an NSB term, transmitted-light segmentation, and the tail comparison table (item 5).

---

## Part D: Measurement strategy

### D.1 Recommendations

1. **Objective: 20x as the default; 10x as a throughput mode.**
   - **Why 20x:**
     - the section (2.3–3.2 µm) is thinner than the bead, so F has a plateau: 0.5–1.5% per µm of defocus for an index-matched bead;
     - about 1.5× more photons per bleaching dose;
     - about 3× less solution background per nM;
     - shell/core discrimination.
   - **10x:** a 4× larger field. At 1 AU it is the least focus-tolerant configuration (−1.9 to −2.3% at 1 µm). Use about 3–4 AU (washed) if NIS-Elements confirms the iris reaches it, or hold focus tightly.
2. **Pinhole: 1 AU** (0.7–1.2 AU is fine) at 20x. This agrees with the 1 AU recommendation of [S6].
3. **Single plane, not z-stacks, for routine reads.**
   - Place it at the **measured stationary point of F(z₀)** (Exp. 5). That is the equator for an index-matched bead; for polystyrene or another mismatched bead, use wherever $dF/dz_0=0$ is measured. Set it as a fixed Perfect Focus or transmitted-light offset.
   - Use a z-sum only for calibration, or at 10x, 1 AU.
4. **Metric and segmentation.**
   - **Segment** on transmitted light acquired with the scan, never on PE, to avoid low-signal selection bias. Measure each bead's R.
   - **Metric:** F per bead, annulus-subtracted and corrected for excluded volume if unwashed (§B.4.6). Report $N_{PE}=4\pi R^2\hat\sigma_s$, or F normalised by R per §A.3.
   - **Focus QC:** transmitted-light focus metric for all beads. PE peak/F only where the rim peak is ≥ ~200 photoelectrons.
   - **Never quantify with the rim peak.** Reject doublets and touching beads.
5. **Settings (20x/0.80):**
   - 561 nm at **1–2 µW measured at the sample** (5% sublinearity is ≈ 2 µW);
   - galvano **2 µs** dwell (1 µs if the LOD region is not needed);
   - 2048² at zoom 1 (0.43 µm, ≈ 18 pixels per bead, 0.88 mm field, 4–9 s per frame);
   - **one field per well**, one frame;
   - emission band ≈ 575–650 nm on a GaAsP channel;
   - HV set on the top standard so its brightest rim pixel sits at 70–80% of full scale, within the detector's linear range (Exp. 2);
   - offset keeping background above 0;
   - dose about 0.02–0.05% bleach per frame.
   - **488 nm** is an alternative (0.5–0.75× absorption, wider emission band); test it in Exp. 7.
6. **Bleaching guard:**
   - focus in transmitted light or with Perfect Focus [S12];
   - expose each field once;
   - fix frames and power across all wells;
   - optionally add n-propyl gallate (1.7× [S3]) after checking it does not disturb binding.
7. **Bead sampling:**
   - ≥ 100 analysed beads per well (one field normally suffices; §B.6.1) and ≥ 2 wells per condition;
   - take the median or a trimmed mean;
   - SE = $c_v/\sqrt N$, and add the Poisson CV of the bound count at low analyte.
8. **Wash-to-imaging timing:** see §D.3 for the plate timeline. Rules by Λ (measured in Exp. 11; treat it as possibly 8.6e-4 s⁻¹ until then):
   - **Λ ≲ 2×10⁻⁴ s⁻¹:** wash the plate in one go, settle by plate spin, image in randomised order. Apply the $Fe^{\Lambda\Delta t}$ correction only where ΛΔt ≤ 0.2; a 25 min plate gives ΛΔt ≤ 0.3, so stagger the halves.
   - **2×10⁻⁴ ≲ Λ ≲ 10⁻³ s⁻¹:** **column-staggered washes**, with each column imaged at a fixed delay (e.g. 5 ± 0.5 min after its wash) and timestamped. Or use a no-wash read.
   - **Λ ≳ 10⁻³ s⁻¹:** a **no-wash read** (mid/high range), or sucrose drying with dried standards [S1]. Crosslinking is untested.
   - **Always:** interleave and randomise standards and samples; image a reference well at the start and end; keep incubation length, bead number per volume, mixing and temperature fixed and logged.
9. **Detection antibody and format** (§A.2.5):
   - $D_T\approx1$–$2K_2$ by default;
   - raise it to 2–5 × $K_2$ only if Exp. 9 shows NSB is negligible;
   - switch to two-step if the hook falls within 10× of the expected upper sample range.
10. **Standard-curve model:**
    - a global fit of the mechanistic model (§A.2), or a 5PL with an explicit hook term; a plain 4PL only in the ambient, excess-label regime [S13];
    - ≥ 8 non-zero standards spanning the hook, plus blanks;
    - weight by the measured variance function;
    - **hook guard:** unknowns at two dilutions (1× and 10×) must agree [S7];
    - **LOD:** blank plus 3 SD of blank **well means** (NSB-dominated);
    - restrict the reportable range to $|d\ln N/d\ln A|\ge0.5$.
11. **Absolute calibration.**
    - Use the solution-PE reference with the **measured T**: $\sigma_s=cF/(2\pi RS_{sol}T)$ (§B.3.4).
    - For a bead that is not index-matched, apply the measured bead-optics factor, or rely on the flow-cytometry cross-check with PE-quantitation beads.
    - Correct with $n_{PE}$.
    - Report PE per bead and PE/µm², with stated uncertainty.

### D.2 Protocol skeleton

1. **Session start.**
   - Warm up the system for 2–3 h [S6].
   - Measure µW at the sample (Exp. 1) and acquire the flat field (Exp. 3).
   - Image a reference standard; log the temperature.
2. **Assay.**
   - Fixed $n_b$ per fixed $V$ (counted, ≤ 5% CV; assumption) and fixed $D_T$.
   - Continuous suspension mixing for a fixed time, then a fixed wash protocol (staggered by column per §D.1 item 8) or no wash.
   - Run in the glass-bottom imaging plate (#1.5H), or transfer to it.
   - **Settle by a brief plate spin** (e.g. 1 min at ~100–300 g; assumption: about 5 s of travel through 1.5 mm, against ~15 min by gravity), or use a magnet if the beads are magnetic.
3. **Focus.** Perfect Focus or transmitted light on the coverslip, then the measured offset to the F stationary point. No fluorescence exposure before acquisition.
4. **Acquire.**
   - 20x, 1 AU, 1–2 µW, 1–2 µs, 2048² at zoom 1, one field per well, PE and transmitted light together.
   - Fixed, logged time since wash; randomised order within the timing constraint.
5. **Analyse.**
   - flat-field correct;
   - segment beads on transmitted light (centre, R);
   - compute F with the annulus and excluded-volume correction;
   - QC: focus flag, doublets, edge beads;
   - normalise by R; take the per-well median;
   - apply the Λ correction only if ΛΔt ≤ 0.2;
   - convert to PE per bead;
   - fit the curve; run the dilution check.
6. **Session end.** Re-image the reference well (drift and Λ); log power, HV and temperature.

### D.3 Plate timeline (derived)

**Per-well time** (assumptions: about 3–5 s for a stage move plus Perfect Focus per field, a ~10% flyback overhead, and one field per well):
- 2 µs dwell: 9–10 s per frame + move ≈ 12–15 s.
- 1 µs dwell: 4.6 s per frame + move ≈ 8–10 s.

| Format | 2 µs dwell | 1 µs dwell | Spread in PE loss at Λ = 8.6e-4 s⁻¹ (2 µs) | At Λ = 1e-4 s⁻¹ |
|---|---|---|---|---|
| 96 wells, single wash | 19–24 min | 13–16 min | 63–71% | 11–13% |
| One column (8 wells) | 1.6–2 min | 1.1–1.3 min | ±4–5% within column | ±0.5% |
| 96 wells, 2 fields per well | 35–42 min | 21–27 min | 84–89% | 19–22% |

**Consequences:**
- An unstaggered single-wash plate is acceptable only if Λ ≲ 10⁻⁴ s⁻¹ and the correction is applied.
- Column staggering brings the within-column spread to ±0.5–5%.
- Gravity settling (≈ 15 min at 1.5 mm) would by itself use most of a 10 min delay window. This is why the plate spin is part of the protocol.
- Reducing to 384-well plates helps only with a low fill height, about 0.5 mm (≈ 5 min settling); the spin is simpler.

---

## Part E: Open questions and what to measure or source first

In priority order:

1. **Bead material and index.** Polystyrene, PMMA, silica or magnetic? This now ranks first.
   - The ray trace (§B.1.4) puts the equatorial signal at ≈ 0.6–0.75 of the index-matched value and makes F(z₀) asymmetric.
   - Absorbing magnetic beads break the shell model further.
   - **Measure F(z₀) symmetry (Exp. 5).** A full wave-optical model (Mie or FDTD of a shell emitter on an index-mismatched sphere, with the confocal pinhole) is needed to replace the geometric estimate; it is not done here.
2. **Instrument identity.**
   - Which 20x is fitted (NA 0.75 or 0.80)?
   - Is the PE channel GaAsP or multialkali, and on a DUX-VB or DUX-ST?
   - Is there a transmitted-light detector, and Perfect Focus on a Ti2-E?
   - What is the **maximum AU per objective** in NIS-Elements (for 10x at 3–4 AU)?
   - What is the GaAsP analog anode-linearity limit? [S5, S11]
3. **$k_{-2}$ (Λ) on our beads** (Exp. 11). This decides the wash, timing and plate format (§D.1 item 8, §D.3) [S1].
4. **Non-specific binding** as a function of $D_T$, with its bead and well CVs (Exp. 9). It sets the LOD and the $D_T$ choice. Literature blank levels have not been sourced: Simoa zero-analyte "on" fractions in molecules/µm², Luminex/CBA blank MFI in PE molecules from QuantiBRITE. That needs a search.
5. **$w(z)$ tails and $T$** (Exp. 4, extended). These set the plateau width (±1.8–2.1 µm), solution background (1.8–2.65 PE/µm² per nM), absolute calibration (T = 0.79–0.999) and ring contrast.
6. **PE linearity and bleaching on beads** (Exp. 7). Measure the ≈ 2 µW threshold, φ_d in our buffer, the dark state, and **density-dependent brightness** (PE-D/unlabelled-D dilution at fixed $D_T$).
7. **Absolute PE per bead cross-check.** Run flow cytometry against PE-quantitation beads (Exp. 10/13). It also gives a confocal-independent bead-to-bead CV.
8. **Active capture sites $N_S$, $n_{PE}$, bead size CV** (Exp. 10/11; vendor CoA).
9. **Independence test** (one-step vs two-step at equilibrium): whether $K_2=K_4$.
10. **Whether the hook lies within the sample range** for the lab's analyte, given the actual $S_T$ and $D_T$ [S7].
11. **Temperature dependence** of Λ and of PE brightness [S15]: log temperature and measure the Arrhenius factor if the room drifts.
12. **Literature not consulted.** These need a search before they can be cited:
    - FMAT (Applied Biosystems 8200) homogeneous confocal bead immunoassays (Miraglia et al. 1999; Swartzman et al. 1999), the closest precedent for the no-wash read;
    - Luminex MAGPIX imaging of PE on 6.5 µm beads;
    - BD QuantiBRITE PE quantitation (Pannu et al. 2001);
    - Ekins' ambient-analyte theory;
    - transport-kinetics models of surface sandwich assays (e.g. Zimmermann, Delamarche and Wolf 2005);
    - near-interface emission theory (Lukosz & Kunz 1977; Chew 1988).
13. **Constants used without a primary citation in this report:**
    - R-PE ε, Φ and τ (candidate sources: Oi, Glazer & Stryer 1982; Glazer 1985; an R-PE lifetime measurement);
    - diffusion coefficients of R-PE and of IgG conjugates;
    - GaAsP QE curves (Hamamatsu);
    - the random-sequential-adsorption jamming fraction 0.547 (Feder 1980).

    They set I_sat, the ≈ 2 µW threshold, the 230–350 photons per PE and the steric ceiling, so each carries about ±30% until sourced.

**If there is only one day:**
- Exp. 1 (power) and Exp. 2 (photon transfer).
- Exp. 5: a single-bead z-series at 20x and 10x, 1 AU, with transmitted-light images, which answers the bead-optics question.
- The solution/glass edge z-scan (Exp. 4), which answers $w$ and $T$.
- A post-wash time course at 0, 5, 15, 30 and 60 min.

---

## Confidence and caveats

**High confidence:**
- Confocal section and resolution formulas, and sampling rules [S10, S6].
- Objective specifications [S11].
- R-PE photodestruction yield and dose law [S3]; saturation scale [S9].
- Transport theory [S2, S8, S14]; the one-step hook [S7]; antibody rate ranges and post-wash dissociation dominated by the detection antibody [S1].
- The thin-shell projection, and the Archimedes result **for index-matched beads** (exact geometry).
- The excluded-volume and T-corrected calibration formulas (derived, dimensionally checked).
- The plate-timing tolerances (arithmetic).

**Medium confidence:**
- Tail-dependent numbers. These are now given as G–L ranges, with the repo and geometric estimates in between.
- The saturation threshold (β ≈ 0.6–0.67; textbook σ and τ).
- The detection-efficiency chain (±2×).
- Optical LOD values (depend on the repo's read-noise and detector assumptions).
- Reference-case binding parameters and the $D_T$ table.
- Sedimentation and plate-spin estimates.

**Low confidence / open:**
- **Bead-optics factors** (geometric collection only; no pinhole, Fresnel or excitation path).
- NSB magnitude and its scaling with $D_T$.
- Active-site fraction, $n_{PE}$, independence of epitopes.
- Density-dependent PE brightness; dark-state rates.
- Field curvature; pinhole relay magnification and maximum AU.
- Near-interface emission.
- Whether surface PE is as bright as PE in solution.

**Where sources or derivations disagreed, and how this revision resolved them:**
1. **20x NA:** 0.75 (stated) vs 0.80 for the λD 20X [S11].
2. **[S1] internal inconsistencies:**
   - 72 vs 225 nm² per IgG;
   - "≈ 50% labelled" holds only for $K_D=1$ nM;
   - bead-fitted $k_{-2}$ of 1e-4 vs biosensor 8.6e-4 (unresolved; measure);
   - streptavidin–biotin $k_{off}$ quoted as ~1e-9 s⁻¹ vs measured ~1e-6.
3. **Diffusion:** non-limiting on 2.5 µm beads [S1], mixed control on 8 µm beads.
4. **Hook:** absent in the two-step ideal model [S13], universal in one-step assays [S7]. These are consistent.
5. **DTT:** protects R-PE [S15] vs no effect [S3].
6. **Two-parameter photophysics** fits B-PE in solution [S9]; R-PE on surfaces shows a dark state [S15].
7. **[S10] SNR example:** 25.1 vs ≈ 15.6 once laser noise is included.
8. **[S6]:** a "1–5% laser" start can exceed PE linearity, which now begins at ≈ 2 µW at 20x.
9. **[S4]:** shell peak-to-peak calibration does not transfer to 8 µm beads at low NA.
10. **[S12]:** the $z=2\lambda\eta/\text{NA}^2$ formula is wide-field. Its quoted 10%/30% peak drop at 0.5/1 µm sits beside this report's 2–5% / 12–18%; all agree that F, not the peak, should be used.
11. **[S14]:** the soluble-competitor threshold is not meaningful at Da ≪ 1.
12. **[S8]:** the Fig. 2 parameter values differ between text and caption; the conclusion is unchanged.
13. **Thick-section rule of thumb:** corrected in §B.3.4.
14. **Rim bleaching:** corrected in §B.5.3.
15. **New in this revision:**
    - **Tail dependence.** The first version's 20x focus tolerance (≤ 0.5% at 1 µm) and its solution-reference "ℓ_eff cancels" were Gaussian-only. They are now 0.5–1.5%, and $T$ (0.79–0.999) has been added to the calibration.
    - **Peak drop.** "18–23% at 1 µm" was from inconsistent sources; it is now 12–18% at 1 µm and 40–54% at 2 µm. The repo's 30% at 2 µm is a sampling effect.
    - **Saturation.** "5% at k = 0.1" was the wide-field average; with confocal weighting it is k ≈ 0.08.
    - **Pseudo-code.** The bleach-dose factor was wrong (it went to zero at low power), and the excluded-volume term was unit-inconsistent. Both are fixed.
    - **Bead refraction** was dismissed in the first version on far-cap grounds. It is now flagged as possibly the largest optical systematic.
    - **Timing.** The 10 min delay conflicted with 15 min gravity settling, and the plate read time had not been computed. Both are now resolved (§D.3).

**Refuted claim that would have mattered.** [S2] says motion raises sphere capture quadratically at low Péclet number. Matched-asymptotic results contradict this: the correction is linear. It was not used. The agitation conclusion rests on an independent Sherwood-number estimate.

**Not covered by any source here:**
- whether commercial PE MESF/quantitation beads are surface- or volume-labelled (check by z-series);
- PE-IgG conjugate heterogeneity;
- bead autofluorescence at 561 nm;
- the effect of n-propyl gallate on antibody binding;
- NSB levels for PE detection antibodies on capture beads;
- the wave-optical bead-lens effect under confocal detection.

---

## Appendix S — Repo simulator: what the AX R image looks like, and what each setting does

> **Operating point (updated 2026-10-24).** These figures and tables were regenerated at the revision-2 operating point: 2 µW at the sample, 2 µs, 20 px per bead, 20x/0.75 at 1 AU unless stated, an index-matched bead, φ = 1.1 × 10⁻⁵, τ = 2.7 ns. All of these come from one parameter file, [`bead_confocal_sim/params.py`](bead_confocal_sim/params.py). The first pass used 10 µW (I/Iₛ ≈ 0.3, already sublinear) and τ = 2.5 ns.
>
> The rerun also fixes a half-pixel registration error in `optics.render`: the bead was drawn half a pixel away from the centre its metrics measured from. Integrated values are unchanged. The ring and peak numbers in S.3 and S.4 moved (they are noted there).
>
> **Interactive versions** of this simulator are three pages in [`bead_confocal_sim/interactive/`](bead_confocal_sim/interactive/): the image of one bead (`pe-bead-confocal.html`), the binding model (`pe-bead-binding.html`) and the measurement strategy (`pe-bead-strategy.html`). Their engines are checked against `optics.py` and `binding.py` (`interactive/tools/check_confocal.py`: agreement within 0.6 %).

The simulator lives in [`bead_confocal_sim/`](bead_confocal_sim/) (numpy, scipy, matplotlib; `python3 run_figures.py`
regenerates every figure below). It is independent of the derivations in Parts A and B and was written in parallel, so
where the two agree the agreement is a real check.

**How it forms the image.**
1. **PSF.** A tabulated 3-D confocal response h(ρ, z): Gaussian-beam excitation (waist 0.433 λ/NA, Rayleigh range in
   water) times the fraction of each defocused emission spot that passes a circular pinhole of the chosen Airy units.
   The second factor is a non-central χ² integral. Unlike a Gaussian section, this has the confocal ≈1/z² tails.
2. **Object.** The shell is a Fibonacci lattice of 60,000 points carrying σ PE/µm².
3. **Rendering.** Points are rendered in 0.1 µm z-slabs, each convolved with h(ρ, z_slab − z₀) in Fourier space.
4. **Scanning.** The image is point-sampled at pixel centres with a one-pixel smear along the fast axis.
5. **Photons.** Saturable PE emission (ε = 1.96×10⁶ M⁻¹cm⁻¹, Q = 0.82, τ = 2.7 ns). Collection is the solid angle in
   water × 0.4 optics × 0.4 GaAsP QE (*assumption*).
6. **Detector.** Poisson counting, then PMT excess noise (F = 1.3), offset, read noise and a 16-bit ADC.
7. **Bleaching.** R-PE destruction yield φ = 1.1×10⁻⁵ per absorbed photon [S3]. A full raster gives every plane the same
   fluence, so the dose per frame is uniform over the shell (Part B §5.1).
8. **Backgrounds.** Optional free PE-antibody in the detection volume, and bead-body autofluorescence.

**Validation.** The integrated signal of a noise-free shell matches the hat-box integral 2πRσ∫H(z − z₀)dz to four
digits at every z₀. The lateral and plane-integrated axial widths fall within ≈30 % of the Zeiss/Pawley formulas
[S10]; see the table below.

### S.1 Two section thicknesses, not one

| Objective, pinhole | Pinhole at sample (µm) | Lateral FWHM (µm) | Axial FWHM, on-axis point (µm) | Axial FWHM, plane-integrated (µm) | Zeiss formula, n = 1 (µm) | Part B, water (µm) |
|---|---|---|---|---|---|---|
| 10x/0.45, 1 AU | 1.57 | 0.62 | 4.0 | 7.1 | 6.8 | 9.2 |
| 10x/0.45, 4 AU | 6.27 | 0.66 | 4.4 | 28 | 20.3 | 26.9 |
| 20x/0.75, 1 AU | 0.94 | 0.40 | 1.5 | 2.6 | 2.3 | 3.2 |
| 20x/0.75, 4 AU | 3.76 | 0.41 | 1.6 | 10.8 | 7.2 | 9.6 |
| 20x/0.80, 1 AU | 0.88 | 0.35 | 1.3 | 2.3 | 2.0 | 2.8 |
| 20x/0.80, 4 AU | 3.53 | 0.38 | 1.4 | 9.5 | 6.4 | 8.5 |

- **The on-axis point width** sets how sharp the rim ring is. The excitation beam caps it, so it barely changes once
  the pinhole is above 1 AU.
- **The plane-integrated width** is what a thin fluorescent sheet, and therefore the bead's *integrated* signal, sees.
  It grows linearly with the pinhole.
- At 1 AU the two differ by ≈1.7×. At 4 AU they differ by 6–7×.

A single "optical section" number hides this distinction, and the distinction decides the measurement strategy.
Exp. 4 of the [characterization plan](PE_bead_confocal_experiments.md) measures both directly.

### S.2 The image of one bead

![Gallery](bead_confocal_sim/figures/fig2_gallery.png)

*One bead, σ = 1,000 PE/µm² (≈2×10⁵ PE), 2 µW, 2 µs, 20 px per bead. Columns: focal offset z₀ = 0, 2, 3.5 µm.
The bottom row is a volume-stained bead carrying the same total PE.*

- **Shell signature.** The rim peak sits at r ≈ 3.8–3.9 µm. Blur pulls it ≈0.1–0.2 µm inside R. The centre is dark,
  not black: the caps leak in through the PSF tails.
  - Peak/centre at the equator is **17.6 at 20x 1 AU**, 5.2 at 10x 1 AU, 2.9 at 10x 2 AU and 3.6 at 20x 4 AU (noise-free; 15.5, 4.5, 2.7 and 3.3 before the registration fix).
  - A volume-stained bead with the same PE gives a flat disc (peak/centre ≈ 1.1).
  - Part B's Gaussian section predicts > 500 at 20x 1 AU. The difference is entirely the tail model. Experiment 5
    measures it, and the answer also fixes how much cap signal a 10x image contains.
- **Defocus.** The ring dims and broadens. At 20x 1 AU its radius follows √(R² − z₀²) only beyond z₀ ≈ 2.5 µm. Below
  that, the projected equatorial rim keeps the peak near R (Fig. 3d), as Part B §3.3 also found. **Ring radius is a poor
  focus sensor. Rim brightness is a sensitive one.**

![Radial profiles](bead_confocal_sim/figures/fig7_profiles.png)

### S.3 Focal-plane offset: which metric survives

![Metrics vs focus](bead_confocal_sim/figures/fig3_metrics_vs_z0.png)

| Setting | Axial FWHM, on-axis / plane (µm) | z₀ range keeping the integrated metric within 5 % | Ring-mean loss at z₀ = 2 µm | Rim-peak loss at z₀ = 2 µm |
|---|---|---|---|---|
| 20x, 1 AU | 1.5 / 2.6 | ±1.75 µm | 27 % | 30 % |
| 20x, 2 AU | 1.6 / 5.3 | ±1.5 µm | 26 % | 30 % |
| 20x, 4 AU | 1.6 / 10.8 | ±1.5 µm | 21 % | 23 % |
| 10x, 1 AU | 4.0 / 7.1 | ±1.5 µm | 17 % | 21 % |
| 10x, 2 AU | 4.4 / 14.5 | ±1.75 µm | 9 % | 13 % |
| 10x, 4 AU | 4.4 / 28 | **±4.5 µm (−2.2 % at the ends)** | 7 % | 10 % |

**Two focus-tolerant regimes.** This reconciles Part B §3.4 with the simulation.
- **Section thinner than the bead** (20x, 1 AU). The integrated signal has a **plateau** while the section lies inside
  the bead, of half-width ≈ R − (plane FWHM)/2 … R − FWHM, here ±1.5–1.75 µm. Part B finds the same plateau
  (−0.5 % at 1 µm, −4.6 % at 2 µm for 20x/0.80 with a Gaussian section).
- **Section much thicker than the bead** (10x, pinhole ≥ 4 AU). The whole bead sits inside the flat top of the plane
  response, so F ≈ 4πR²σ·H(z₀). How flat that is depends on the *shape* of H(z). The pinhole-acceptance model has a
  flat top (−2 % at ±4.5 µm). A Gaussian H of the same width would lose ≈7 %. Experiment 4b measures H(z) and settles it.
- **The worst case is a section about as thick as the bead.** That means 20x at 2–4 AU, or 10x at 1 AU: a ±1.5 µm
  window.
- Ring-mean and rim-peak metrics lose 7–30 % at a 2 µm error in every mode. **Use them only for QC, never as the
  quantity.**
- These are for an index-matched bead. A polystyrene, PMMA or silica bead bends the light and makes the curve lopsided
  (§B.1.4); the interactive page `pe-bead-confocal.html` overlays the ray-trace estimate. The literature review adds that
  surface-labelled polystyrene particles lose their far hemisphere in confocal images (Vorselen 2020), so the bright top
  cap in the geometric ray trace is probably not what a pinhole sees. Experiment 5 measures it.

### S.4 Pixels per bead and sub-pixel position

![Sampling](bead_confocal_sim/figures/fig4_sampling.png)

| Pixels per bead | Pixel (µm) | Rim-peak swing | Ring-mean swing | Integrated swing |
|---|---|---|---|---|
| 8 | 1.00 | 28 % | 15 % | 4.6 % |
| 12 | 0.67 | 39 % | 14 % | 1.5 % |
| 20 | 0.40 | 14 % | 6.7 % | 0.13 % |
| 40 | 0.20 | 2.8 % | 2.6 % | < 0.01 % |

*20x, 1 AU. Swing = max/min over sub-pixel offsets of 0–0.5 px. After the registration fix the bead centre is exact,
so the rim-peak and ring-mean swings now show what one-pixel radial bins do when the ring falls between bin edges;
before the fix they were 29/8.3/5.2/2.2 % and 34/8.1/4.5/2.7 %. The integrated swing hardly moved (2.7 % at 8 px before).
Part B's independent 300-offset Monte Carlo agrees on the integrated metric: CV 0.35 % at 12 px for 20x/0.75.*

- The integrated sum is unbiased at any sampling density and stable from ≈12 px per bead.
- The rim peak needs ≥ 40 px per bead (the Nyquist 25–42 px of [S10] applies to the rim, not to the whole-bead sum).
- At fixed dwell, both the photons and the bleaching dose per frame scale as (px per bead)² (Fig. 4c). Finer pixels
  are equivalent to a longer exposure, not to more information about the integrated signal. **Coarse pixels buy field
  of view, and so beads per frame, at no SNR cost per unit dose.**

### S.5 Laser power, dwell, photobleaching and saturation

![Photon budget](bead_confocal_sim/figures/fig5_photon_budget.png)

| Power at the sample (20x, 1 AU) | Emission per PE at focus (photons/s) | SNR of integrated metric, one frame, 100 PE/µm², 2 µs | PE lost per frame |
|---|---|---|---|
| 1 µW | 1.0×10⁷ | 40 | 0.029 % |
| 3 µW | 2.9×10⁷ | 66 | 0.087 % |
| 10 µW | 7.8×10⁷ | 110 | 0.29 % |
| 30 µW | 1.5×10⁸ | 155 | 0.87 % |

- **The exchange rate.** In the linear regime, SNR vs fraction bleached falls on one line whatever the power/dwell split
  (Fig. 5c). Detected photons per PE over its lifetime come out at ≈340 at 20x/0.75 and 2 µW (≈275 at 10 µW, where
  saturation wastes absorbed photons), against 347–351 in Part B §4.5. A 5 % bleach budget is ≈17 detected photons per PE.
- **Saturation** bends the line. At 30 µW the 20x focus reaches I/Iₛ ≈ 1, the same scale as Mathies' B-PE optimum
  [S9], so each % bleached buys less SNR. Iₛ is ≈19 kW/cm² (5×10²² photons cm⁻² s⁻¹), matching [S9].
  **Stay at I/Iₛ ≲ 0.08: ≈2 µW at the sample at 20x, ≈6–7 µW at 10x** (Part B, with confocal weighting). Lengthen dwell or average to get photons.
- **Saturation solved point by point** (added 2026-10-24, `interactive/src/confocal-engine.js`). Letting each molecule
  saturate at its own irradiance, h = I/(1 + k₀I)·D, puts the 5 % point at k₀ ≈ 0.10 for an in-focus sheet (2.9 µW at
  20x/0.75, 2.5 µW at 20x/0.80, 8 µW at 10x), at 3.0–3.3 µW for the shell's rim peak, and at **5.3–5.9 µW (20x) and
  12 µW (10x) for the integrated F of a shell**, because much of F comes from molecules away from the focal plane. The
  first-order Gaussian estimate above is therefore conservative for F. The default stays at 1–2 µW, because PE's
  millisecond dark state and ±30 % on σ and τ are not in the model (Experiment 7 measures the real threshold).
- **Bleaching is a uniform gain loss in one plane.** It scales every pixel and every metric by the same factor
  (Part B §5.3). It becomes a bias only through repeated exposure: z-stacks, live focusing on PE, and re-imaging the
  same field.

### S.6 Detector gain

![Gain](bead_confocal_sim/figures/fig6_gain.png)

- Gain (DN per photoelectron) leaves the integrated photoelectron count and the bead-to-bead CV unchanged until rim
  pixels clip. Clipping then cuts the integrated value fast.
- At 2 µW and with the 16-bit ADC, clipping starts at **gain ≈ 100 DN/e⁻ for 3,000 PE/µm²** and ≈ 500 DN/e⁻ for 300 PE/µm² (at 10 µW: 20 and 200).
- In the default 12-bit mode [S5] every threshold is 16× lower.
- **Choose one gain from the brightest standard (rim ≤ 60–70 % of full scale) and never change it within a plate.**

### S.7 Bead position in the field

![Field position](bead_confocal_sim/figures/fig8_field.png)

*Assumed 15 % edge vignetting and 1–3 µm of field curvature.*
- The integrated metric loses only the vignetting plus a little curvature (−16 % at the edge with 1 µm, −30 % with 3 µm).
- The ring-mean loses up to about half.
- Real fall-off is ≥ 10 % corner to centre on most systems [S6]. The bead-field example in [S12] was a Nikon 20x/0.75.
- **Flat-field every session (Experiment 3)** and keep beads inside the region where the correction is < 1.25×.

### S.8 Backgrounds and the limit of detection

![Backgrounds](bead_confocal_sim/figures/fig9_backgrounds.png)

*LOD in PE molecules per bead: 3 × shot-noise SD of a blank bead, integrated metric, 2 µW, 2 µs, 20 px per bead. These match Part B's `lod.py` table (64–66 / 91–93 / 214–220 / 649–666 at 20x).*

| Mode | V_eff (µm³) | Detector only | Free PE-Ab 0.1 nM | 1 nM | 10 nM | Autofluorescence 0.1 PE-eq/µm³ | 1 | 10 |
|---|---|---|---|---|---|---|---|---|
| 20x, 1 AU | 0.53 | 66 | 94 | 220 | 668 | 80 | 158 | 460 |
| 10x, 1 AU | 3.7 | 99 | 136 | 311 | 938 | 111 | 190 | 524 |
| 10x, 4 AU | 11.2 | 65 | 125 | 344 | 1,071 | 76 | 141 | 402 |

- **Photon noise alone is not the floor.** About 65 PE per bead (≈0.3 PE/µm²) at 2 µW. In practice the floor will be
  non-specific PE binding and bead-to-bead site variation (Experiment 9c).
- **No-wash reads** pay for every nM of free PE-antibody left in solution. The 20x at 1 AU has the smallest detection
  volume and suffers least. Annulus subtraction also over-subtracts, because the bead excludes solution PE (Part B §4.6).
- **Bead autofluorescence** of ≈1 PE-equivalent per µm³ of bead volume already costs ≈2.4× in LOD at 20x. Measure it.

### S.9 Binding: the coverage that reaches the optics

![Binding](bead_confocal_sim/figures/fig1_binding.png)

*Since 2026-10-24 the defaults are Part A's reference case (`params.BINDING`): K_D1 = 20 pM (k₁ = 5×10⁵ M⁻¹s⁻¹,
k₋₁ = 10⁻⁵ s⁻¹), K_D2 = 2.15 nM (k₂ = 4×10⁵, k₋₂ = 8.6×10⁻⁴ s⁻¹), k₃ = k₁, k₄ = k₂, 10⁶ sites per bead, 10⁴ beads in
50 µL (capture capacity 332 pM), diffusion 6, 3.5 and 3 × 10⁻⁷ cm²/s for analyte, antibody and complex. It reproduces
the A.2.4 table (498 PE per bead at 1 pM after 1 h). The first pass used looser generic constants; the shapes are the same.*

- **(a) The detection antibody sets the ceiling.** The PE coverage ceiling is D₀/(K_D2 + D₀): 0.5 at D₀ = K_D2 and
  only 0.09 at D₀ = K_D2/10. The solid curves fall below the closed form because the beads deplete the analyte.
- **(b) The one-step hook** begins once analyte exceeds the detection antibody (A₀ ≳ D₀ + K_D2). Free analyte titrates
  the label in solution and fills the capture sites unlabelled.
- **(c) After a perfect wash, PE decays as a single exponential** at k₋₂ + k₋₃. Separating the two needs the perturbation
  experiments in Part A §A.4 and Experiment 11.
- **(d) Transport.** At 10⁶ sites the Damköhler number is 0.28 for the analyte and 0.38 for the antibody: diffusion
  matters a little. At k_on·N_S ≳ 10¹² M⁻¹s⁻¹ (Da ≳ 1) it slows the approach visibly, without moving the equilibrium.
  After the wash, rebinding slows the PE loss to f₂k₋₂ + f₃k₋₃, a few per cent below k₋₂ + k₋₃ in the reference case
  (Goldstein 1999; the interactive binding page shows both).

### S.10 Every setting at a glance

| Setting | Effect on the integrated metric | Effect on ring / peak metrics | Recommendation |
|---|---|---|---|
| **Pinhole** | Plane-integrated section grows ∝ AU; focus tolerance is best at ≤ 1 AU (20x) or ≥ 4 AU (10x); signal per dose rises with AU | On-axis section capped by the beam; contrast falls as the caps leak in | 20x: 1 AU. 10x: open (≥ 4 AU), unless free PE is present |
| **Laser power** | 5 % sublinear at ≈5–6 µW (20x) and ≈12 µW (10x) when solved point by point; the Gaussian estimate gives ≈2 / 6–7 µW; bleaching ∝ dose | Rim peak 5 % sublinear at ≈3 µW (20x) | Measure µW at the sample. 1–2 µW (20x), ≈6 µW (10x) (Part B); Exp. 7 sets the cap |
| **Gain** | No effect on SNR or CV until clipping | Rim clips first | Fixed per plate, set on the brightest standard |
| **PE surface density** | Linear from the LOD (≈0.1 PE/µm² detector-only) to clipping | Linear | Calibrate PE per DN with PE calibration beads |
| **Photobleaching** | Uniform gain loss per frame (≈0.06 % at 2 µW, 2 µs, 0.4 µm px, 20x) | Same | One frame per field; focus in transmitted light; n-propyl gallate gives ×1.7 [S3] |
| **Pixels per bead** | Stable from 12 px | Needs ≥ 20–40 px | 12–20 px per bead for quantitation |
| **Dwell time** | SNR ∝ √dwell; dose ∝ dwell | Same | 2–4 µs galvano, or matched-dose averaging (Experiment 7d) |
| **Focal-plane offset** | Plateau ±1.75 µm (20x 1 AU), ±4.5 µm (10x 4 AU), ±1.5 µm otherwise | −7 to −30 % at 2 µm | Perfect Focus at the equator (≈3 µm nominal above the glass) |
| **Bead offset in the scan** | Sub-pixel: ≤ 1.5 % at ≥ 12 px, < 0.2 % at 20 px. Field: vignetting + curvature | Sub-pixel 3–39 %; field up to about −50 % | Flat-field; central region |
| **Objective** | 10x: larger field, more cap signal, 1/3 the collection, larger V_eff. 20x: thinner section, best no-wash LOD | 20x gives a crisp ring | 20x at 1 AU by default (Part D); 10x at 3–4 AU as the throughput mode, decided in Exp. 13 |

---

## References

- [S1] Chang L, Rissin DM, Fournier DR, Piech T, Patel PP, Wilson DH, Duffy DC. Single molecule enzyme-linked immunosorbent assays: theoretical considerations. *J Immunol Methods* 378:102–115 (2012). https://pmc.ncbi.nlm.nih.gov/articles/PMC3327511/
- [S2] Berg HC, Purcell EM. Physics of chemoreception. *Biophys J* 20(2):193–219 (1977). https://doi.org/10.1016/S0006-3495(77)85544-6
- [S3] White JC, Stryer L. Photostability studies of phycobiliprotein fluorescent labels. *Anal Biochem* 161:442–452 (1987). https://doi.org/10.1016/0003-2697(87)90473-8
- [S4] Besseling TH, Jose J, van Blaaderen A. Methods to calibrate and scale axial distances in confocal microscopy as a function of refractive index. *J Microsc* 257(2):142–150 (2014/2015). https://pmc.ncbi.nlm.nih.gov/articles/PMC4383648
- [S5] Nikon. AX / AX R with NSPARC: Specifications (2025). https://www.microscope.healthcare.nikon.com/products/confocal-microscopes/ax/specifications
- [S6] Jonkman J, Brown CM, Wright GD, Anderson KI, North AJ. Tutorial: guidance for quantitative confocal microscopy. *Nat Protoc* 15:1585–1611 (2020). https://doi.org/10.1038/s41596-020-0313-9
- [S7] Fernando SA, Wilson GS. Studies of the 'hook' effect in the one-step sandwich immunoassay. *J Immunol Methods* 151:47–66 (1992). https://doi.org/10.1016/0022-1759(92)90104-2
- [S8] Goldstein B, Dembo M. Approximating the effects of diffusion on reversible reactions at the cell surface: ligand-receptor kinetics. *Biophys J* 68(4):1222–1230 (1995). https://pmc.ncbi.nlm.nih.gov/articles/PMC1282020
- [S9] Mathies RA, Peck K, Stryer L. Optimization of high-sensitivity fluorescence detection. *Anal Chem* 62:1786–1791 (1990). https://doi.org/10.1021/ac00216a012
- [S10] Wilhelm S, et al. Confocal Laser Scanning Microscopy: Principles (Carl Zeiss monograph). https://bcf.technion.ac.il/wp-content/uploads/2015/10/Confocal-Principles.pdf
- [S11] Nikon. CFI Plan Apochromat Lambda D series: Specifications (2021). https://www.microscope.healthcare.nikon.com/products/optics/lambda-d-objective-series/specifications
- [S12] Waters JC. Accuracy and precision in quantitative fluorescence microscopy. *J Cell Biol* 185:1135–1148 (2009). https://doi.org/10.1083/jcb.200903097
- [S13] Rodbard D, Feldman Y. Kinetics of two-site immunoradiometric ('sandwich') assays I: mathematical models for simulation, optimization, and curve fitting. *Immunochemistry* 15:71–76 (1978). https://doi.org/10.1016/0161-5890(78)90045-7
- [S14] Goldstein B, Coombs D, He X, Pineda AR, Wofsy C. The influence of transport on the kinetics of binding to surface receptors: application to cells and BIAcore. *J Mol Recognit* 12(5):293–299 (1999). https://personal.math.ubc.ca/~coombs/pubs/jmolrec.pdf
- [S15] Gaigalas A, Gallagher T, Cole KD, Singh T, Wang L, Zhang YZ. A multistate model for the fluorescence response of R-phycoerythrin. *Photochem Photobiol* 82(3):635–644 (2006). https://doi.org/10.1562/2005-05-26-RA-544