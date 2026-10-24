# ERK waves as a mechanochemical relay — literature review

*McGhee Lab · built 2026-10-23 · the same content is laid out as a Scientia note (“ERK waves as a mechanochemical relay — lit review”) with every PDF on the canvas.*

> **Bottom line.** ERK waves are a contraction relay, not a collapse relay: a cell with active ERK contracts and pulls its neighbours; stretch at their E-cadherin junctions sheds EGF-family ligand through ADAM17, and their EGFR → ERK fires within minutes. Cells therefore inch toward the wave source in ~90-min pulses while the signal outruns them several-fold.

## The question, split into testable links

Does a RAS–RAF–MEK–ERK (or EGFR-started) pulse set off a mechanical chain reaction across an epithelium?
- **H1** — ERK weakens the cytoskeleton: faster retrograde actin flow (less free G-actin), weaker integrin binding, or Arp2/3 held back by more capping protein.
- **H2** — Neighbours still held by junctions get stretched; stretch releases EGF-family ligand into the junction; the neighbour's EGFR→ERK fires; repeat.
- **H3** — What would the cells' apparent velocity look like while this propagates?

## Verdicts

**Verdict · H1**

H1 as stated is contradicted for acute ERK pulses: ERK drives protrusion and contraction, not breakdown.
- Measured: blocking MEK lowers Arp2/3 recruitment, protrusion AND retrograde flow (Mendoza et al. 2015); ERK→MLCK and RSK→MYPT1 raise myosin activity (Klemke et al. 1997) (Samson et al. 2019); optogenetic ERK switches on ROCK within 12 min and the cell contracts (Hino et al. 2020).
- What survives: the ERK-active cell lowers its traction on the substrate (~40 min) and turns adhesions over — force moves from substrate to junctions (Hino et al. 2020) (Glading et al. 2004).
- Breakdown happens on other timescales: weeks of oncogenic Ras (ROCK1 down) (Sahai et al. 2001); EPLIN phosphorylation (Han et al. 2007).
- Never measured during a wave: free G-actin, capping protein.

**Verdict · H2**

H2 is supported: stretching an epithelial cell fires its EGFR→ERK through ADAM-mediated ligand shedding at E-cadherin junctions, within minutes.
- Stretch → pEGFR (~1 min) → RAF, MEK, ERK; blocked by EGFR or metalloprotease inhibitors (Hino et al. 2020) (Houtekamer et al. 2025).
- The sensor is the adherens junction (not the tight junction): ADAM17 sits by E-cadherin; strain cleaves an EREG probe at contacts; force-blind E-cadherin stops it (Houtekamer et al. 2025).
- The chain is real: making one cluster contract launches ERK waves into its stretched neighbour; α-catenin loss breaks propagation (Hino et al. 2020).
- The ligand is redundant and travels tens of µm, not only into one junction (Lin et al. 2022) (Deguchi et al. 2024).

**Verdict · H3**

Cells creep toward the wave's source in pulses, several times slower than the wave.
- Wave: ~1.5–4 µm/min (skin, MDCK) (Hiratsuka et al. 2015) (Deguchi et al. 2024); cells: 0–0.8 µm/min depending on density (Tlili et al. 2018).
- Each pass: stretch → ERK (+3 min) → contraction; period ~90 min; waves ~400 µm apart (Hino et al. 2020).
- Direction: against the wave (Aoki et al. 2017); migration is most efficient for waves near ~2 µm/min (Boocock et al. 2021) (Fukuyama et al. 2025).

## Revised model

ERK waves are a contraction relay, not a collapse relay.
1. A cell's ERK turns on — a leader cell, a growth-factor input, an apoptotic or Ras-hyperactive neighbour.
2. ERK → ROCK, MLCK and RSK→MYPT1 → actomyosin contracts; grip on the substrate drops, so the pull goes into the junctions.
3. The contracting cell pulls its neighbour through E-cadherin / α-catenin — the neighbour is stretched.
4. Junction tension → ADAM17-type shedding of an EGF-family ligand (EREG, AREG, TGF-α, HB-EGF, EGF; redundant), reaching tens of µm.
5. Ligand → EGFR → RAF → MEK → ERK in the neighbour (minutes) → back to step 2, one cell further on.
6. ERK pulses last ~30 min; rear-polarized contraction makes the wave run one way (measured), and it repeats every ~1–1.5 h. A refractory or desensitized phase is assumed in the models, not measured directly.
**Where the original idea fits:** steps 3–5 are what you proposed. Step 2 is inverted — contraction, not breakdown, makes the stretch (a softening cell would relax its neighbours, not stretch them).

## What the apparent cell velocity looks like

Picture a kymograph of one cell as the waves pass: a slow drift toward the source with a pulse every ~90 min.
- Signal speed: 1.5 ± 0.3 µm/min (skin SPREADs) · 1.4 µm/min (skin wound) · ~3 µm/min (MDCK, optogenetic mimic) · 1–2 → ~4 µm/min (HB-EGF/TGF-α → EREG/AREG) · ~0.4 µm/min (cochlear duct) · ~10 µm/h (zebrafish scale).
- Cell speed: 0–0.8 µm/min in MDCK monolayers (falls with density); ~0.33 µm/min for PtK1 sheets — the wave outruns the cells roughly 2–10×.
- Rhythm: ~90-min period, waves ~400 µm (~20 cells) apart, front ~35 µm wide; ERK pulse ~30 min.
- Within one pass: the cell is stretched first, its ERK peaks ~3 min later, then it contracts — so its velocity reverses once per pass, with net displacement against the wave direction.
- Mechanical (velocity) waves can run ~10 µm/min opposite to the cell motion even without an ERK readout (Tlili et al. 2018).
- Test that separates the two models: a contraction relay pulls neighbours TOWARD the activated cell (observed (Hino et al. 2020)); a breakdown relay would let them recoil AWAY from it.

## H1 · Does ERK break the cytoskeleton down?

**Verdict: not for an acute ERK pulse — ERK drives protrusion and contraction.** Stress-fibre loss appears only with chronic Ras signalling or specific substrates (EPLIN). One part of the idea survives: an ERK-active cell loosens its grip on the substrate (traction falls, adhesions turn over), so its force goes into the junctions. The G-actin and capping-protein steps were never measured.

### H1a / H1c

ERK speeds protrusion and recruits Arp2/3 — the opposite of Arp2/3 inhibition (H1c).
- Blocking MEK lowered Arp2/3 recruitment, edge protrusion and lamellipodial retrograde flow (baseline 600–800 nm/min) in PtK1 cells (Mendoza et al. 2015); ERK phosphorylates WAVE2 and Abi1 of the WAVE regulatory complex (Mendoza et al. 2011).
- So faster retrograde flow (H1a) goes with MORE actin polymerization when ERK is on — not with less free G-actin.
- Basis: measured (speckle microscopy, live Arp3) in single migrating cells, not during an ERK wave. Capping protein: never measured.

*Mendoza et al. 2015 — ERK reinforces actin polymerization to power persistent edge protrusion during motility*
  - p. 1: “we showed that ERK controlled the rate and timing of actin polymerization by promoting the recruitment of the actin nucleator Arp2/3 to the leading edge”
  - p. 5: “Treatment with the MEK inhibitor reduced actin retrograde flow and actin assembly and disassembly rates at the cell edge in protruding edges”
  - p. 5: “revealed typical lamellipodial actin characteristics: rapid retrograde flow (600–800 nm/min) towards the cell center”
  - p. 3: “DMSO-treated sheets moved at a median velocity of 0.328 μm/min while AZD-treated sheets moved at 0.198 μm/min”

*Mendoza et al. 2011 — ERK-MAPK drives lamellipodia protrusion by activating the WAVE2 regulatory complex*
  - From the abstract: ERK "directly phosphorylates two WRC components: WAVE2 and Abi1"; the phosphorylations are required for WRC interaction with Arp2/3 and actin. (Author manuscript is in PMC, PMC3078620.)

*Samson et al. 2022 — ERK signaling for cell migration and invasion*
  - p. 5: “we showed that ERK-induced actin polymerization converts initiated protrusions into prolonged events with the power to overcome membrane tension”

### The contraction alternative

ERK makes actomyosin contract, through MLCK, RSK → MYPT1 and ROCK.
- ERK phosphorylates MLCK → more myosin light-chain phosphorylation (Klemke et al. 1997) (Nguyen et al. 1999); RSK phosphorylates MYPT1 (Ser-507), which keeps myosin phosphatase off myosin (Samson et al. 2019).
- In MDCK monolayers, optogenetic ERK switches on ROCK within 12 min and the cells contract; the ROCK inhibitor Y-27632 blocks it (Hino et al. 2020) (quotes in the Hino 2020 region, H2 column).
- Basis: measured — biochemistry (1997–2019) and live FRET in monolayers (2020).

*Nguyen et al. 1999 — Myosin light chain kinase functions downstream of Ras/ERK to promote migration of urokinase-type plasminogen activator-stimulated cells in an integrin-selective manner*
  - p. 1: “MLCK was phosphorylated by a MEK-dependent pathway and apparently activated, since serine-phosphorylation of myosin II regulatory light chain (RLC) was also increased”

*Samson et al. 2019 — p90 ribosomal S6 kinase (RSK) phosphorylates myosin phosphatase and thereby controls edge dynamics during cell migration*
  - p. 1: “RSK phosphorylates myosin phosphatase–targeting subunit 1 (MYPT1) at Ser-507, which promotes an interaction of Rho kinase (ROCK) with MYPT1 and inhibits myosin targeting”

*Klemke et al. 1997 — Regulation of cell motility by mitogen-activated protein kinase*
  - p. 1: “MAP kinase (ERK1 and ERK2) influences the cells’ motility machinery by phosphorylating and, thereby, enhancing myosin light chain kinase (MLCK) activity leading to phosphorylation of myosin light chains (MLC)”
  - p. 3: “MAP Kinase Is Critical for Cell Migration but Not Adhesion or Spreading on Collagen”

### H1b

What survives of H1: an ERK-active cell lets go of the substrate (H1b, in part).
- Optogenetic ERK lowered traction on the substrate within ~40 min while the cell contracted (Hino et al. 2020) — the force is redirected into the junctions (quote in the Hino 2020 region, H2 column).
- ERK phosphorylates and activates m-calpain (calpain-2) for rear de-adhesion (Glading et al. 2004); ERK is needed for adhesion turnover at the front (Webb et al. 2004).
- Against a pure "weaker integrins" story: ERK was needed for migration but not for adhesion or spreading on collagen (Klemke et al. 1997).
- Basis: traction measured; adhesion turnover measured in single cells; integrin binding itself not measured during waves.

*Glading et al. 2004 — Epidermal growth factor activates m-calpain (calpain II), at least in part, by extracellular signal-regulated kinase-mediated phosphorylation*
  - p. 1: “m-calpain activation by growth factors requires extracellular signal-regulated kinase (ERK); this enables tail deadhesion and allows productive motility”
  - p. 1: “We now show that ERK directly phosphorylates and activates m-calpain both in vitro and in vivo”

*Webb et al. 2004 — FAK-Src signalling through paxillin, ERK and MLCK regulates adhesion disassembly*
  - From the abstract: FAK, Src, p130CAS, paxillin, ERK and MLCK "are critical for adhesion turnover at the cell front". No open PDF.

### H1d

ERK-driven stress-fibre loss is real but belongs to chronic signalling or specific substrates (H1d).
- Weeks of oncogenic Ras/ERK lower ROCK1 and stress fibres despite high Rho-GTP; MEK inhibition restores them (Sahai et al. 2001). The opposite sign in B-Raf-null fibroblasts: ERK keeps stress fibres up via ROCKII (Pritchard et al. 2004).
- ERK phosphorylates the actin cross-linker EPLIN, lowering its affinity for filaments; growth factor then disassembles stress fibres (Han et al. 2007).
- Basis: measured, in fibroblasts and transformed cells over hours to weeks — never during a minutes-long ERK wave.

*Sahai et al. 2001 — Cross-talk between Ras and Rho signalling pathways in transformation favours proliferation and increased motility*
  - p. 1: “We show that the sustained ERK–MAP kinase signalling resulting from transformation by oncogenic Ras down-regulates ROCK1 and Rho-kinase, two Rho effectors required for actin stress fibre formation”
  - p. 4: “after 2 weeks treatment, proliferating cells had grown out”

*Han et al. 2007 — Extracellular signal-regulated kinase/mitogen-activated protein kinase regulates actin organization and cell motility by phosphorylating the actin cross-linking protein EPLIN*
  - p. 1: “Phosphorylation of the C-terminal region of EPLIN reduces its affinity for actin filaments”
  - p. 1: “stimulation with platelet-derived growth factor (PDGF) induces stress fiber disassembly and relocalization of EPLIN to peripheral and dorsal ruffles”

*Pritchard et al. 2004 — B-Raf acts via the ROCKII/LIMK/cofilin pathway to maintain actin stress fibers in fibroblasts*
  - From the abstract: in B-raf−/− fibroblasts, LOSS of ERK signalling reduced ROCKII expression and stress fibres, restored by active MEK — the opposite sign to Sahai 2001. (PMC480888, not in the open-access subset.)

### Untested: H1a / H1c

Untested: does free G-actin, capping protein (CapZ) or retrograde flow change as an ERK wave passes through a monolayer?
- No paper here measured G-actin or capping protein during ERK pulses; the only flow data are single PtK1 cells under MEK inhibition (Mendoza et al. 2015).
- Cheapest test: speckle or photoactivation flow in EKAREV-NLS MDCK sheets, aligned to each cell's ERK peak.

## H2 · Does a stretched neighbour shed EGF-family ligand and fire its own EGFR → ERK?

**Verdict: yes — measured in MDCK monolayers, mechanism identified in 2025.** Stretch at E-cadherin junctions activates ADAM17-type shedding; the shed ligand (redundant: EGF, HB-EGF, TGF-α, EREG, AREG) activates EGFR → RAF → MEK → ERK within minutes; the same machinery carries waves out of apoptotic and Ras-hyperactive cells. Compression pushes ERK the other way.

### Stretch → EGFR → ERK

Stretch alone switches on EGFR → RAF → MEK → ERK within minutes, through metalloprotease shedding.
- Uniaxial stretch of MDCK raised autophosphorylated EGFR (~1 min), then RAF1, MEK and ERK; an EGFR inhibitor or marimastat blocked it (Hino et al. 2020).
- 18% equibiaxial strain raised pEGFR, pMEK and pERK in 15 min; afatinib, TAPI-2 or marimastat prevented most of it (Houtekamer et al. 2025).
- ERK rises with the amount of stretch — significant from 30% in MDCK (Crozet & Levayer 2023).
- Basis: measured, with externally applied stretch (18–50%), larger than in a spontaneous wave.

*Hino et al. 2020 — ERK-Mediated Mechanochemical Waves Direct Collective Cell Polarization*
  - p. 4: “As anticipated, uniaxial stretch of the MDCK cells resulted in ERK activation”
  - p. 4: “Remarkably, immunoblotting showed that cell stretch transiently increased auto-phosphorylated EGFR, followed by phosphorylation of the downstream kinases including RAF1, MEK1/2, and ERK1/2”
  - p. 4: “These observations strongly suggest that the stretch-induced ERK activation requires EGFR and ADAM17 activity.”
  - p. 5: “After optogenetic ERK activation, ROCK activity increased, then plateaued within 12 min after the blue light exposure”
  - p. 5: “We found that Y-27632 suppressed the ERK-induced cell contraction”
  - p. 5: “The traction force exerted by the 2paRAF-expressing cells markedly decreased within 40 min after the start of blue light exposure”
  - p. 6: “Upon rapamycin treatment, the cells with RA Rho GEF began to contract, resulting in the extension of the adjacent EKAREV-NLS–expressing cell cluster toward the RA Rho GEF-expressing cell clusters”
  - p. 6: “With this trigger, ERK activation waves emerged at the interface and were unidirectionally propagated toward the extended EKAREV-NLS–expressing cell cluster”
  - p. 6: “Coordinated ERK activity propagation was severely disrupted in the α-catenin KO cells”
  - p. 6: “the displacement of the EKAREV-NLS–expressing cells was oriented toward the RA Rho GEF-expressing cell clusters and was directed opposite the ERK activation waves”
  - p. 4: “the ERK activation rate, i.e., the ERK activity change per minute, and the x-strain rate oscillated almost synchronously with an approximately 90 min period”
  - p. 4: “temporal cross-correlation analysis revealed that the ERK activation rate lagged 3 min behind the x-strain rate”
  - p. 8: “~35 µm width and 400 µm intervals at 3 µm min-1 velocity”

*Crozet & Levayer 2023 — Emerging roles and mechanisms of ERK pathway mechanosensing*
  - p. 2: “In MDCK (Madin–Darby Canine Kidney) cells, an increase in ERK activity is measured after 5 min of substrate stretch (and 1 min for EGFR phosphorylation), and ERK activity gradually rises with the degree of stretch (statistically significant at 30%, 40% and 50% stretch)”

### The chain reaction

The chain reaction is real: a contracting cell launches an ERK wave into its stretched neighbour.
- Making one cluster contract (rapamycin-induced RhoGEF) stretched the adjacent cluster; ERK waves started at the interface and travelled into it; α-catenin knockout broke propagation (Hino et al. 2020).
- Seen in vivo too: an EGFR–ERK relay drives a wave of contractility in the Drosophila tracheal placode (Ogura et al. 2018); in MDCK wound healing, sheet movement and ERK propagation form a positive feedback loop (Matsubayashi et al. 2004).
- Basis: measured.

*Ogura et al. 2018 — A Switch-like Activation Relay of EGFR-ERK Signaling Regulates a Wave of Cellular Contractility for Epithelial Invagination*
  - From the abstract: in the Drosophila tracheal placode a switch-like "relay of EGFR-ERK signaling among tracheal cells", coupled to myosin, drives a wave of contractility for invagination. No open PDF.

*Matsubayashi et al. 2004 — ERK activation propagates in epithelial cell sheets and regulates their migration during wound healing*
  - From the abstract: wound-induced ERK activation "propagates in cell sheets in accordance with the cell sheet movement"; blocking sheet movement by disrupting actin suppresses the propagation — "a positive feedback loop". The first report of ERK propagation in MDCK sheets. No open PDF.

### The mechanosensor

The sensor is the E-cadherin adherens junction, and the shedding happens at cell–cell contacts.
- ADAM17 sits in the proximity of E-cadherin; strain cleaved an EREG shedding probe at contacts within 15 min; force-blind T151-E-cadherin abolished the cleavage and most of the EGFR response (Houtekamer et al. 2025).
- Your "tight junction" becomes the adherens junction; the ligand is released at the contact, as you proposed.
- Basis: measured (proximity labelling, ratiometric probe, mutants). How E-cadherin tension reaches ADAM17 is unknown (Src suggested).

*Houtekamer et al. 2025 — E-cadherin mechanotransduction activates EGFR-ERK signaling in epithelial monolayers by inducing ADAM-mediated ligand shedding*
  - p. 1: “Strain-induced EGFR-ERK signaling depends on mechanosensitive E-cadherin adhesions.”
  - p. 1: “Proximity labeling identified the metalloproteinase ADAM17, an enzyme that mediates shedding of soluble EGFR ligands, to be closely associated with E-cadherin.”
  - p. 4: “subjected monolayers to 18% static substrate stretch for 30 minutes”
  - p. 7: “Pretreatment of cells with TAPI-2 largely prevented the increase in pERK levels by mechanical strain”
  - p. 8: “Quantification of the mScarlet/mNeon ratio showed that the presence of the uncleaved probe at individual cell-cell contacts was significantly decreased after mechanical strain”
  - p. 8: “cells in which endogenous E-cadherin is replaced with T151-E-cadherin do not show significant strain-induced cleavage of mScarlet-EREG-mNeon, confirming that AJs are essential for relaying mechanical strain to control ADAM activity”
  - p. 6: “Some strain-induced pERK increase remained in Afatinib-treated cells, which is likely due to EGFR-independent activation of ERK”

### Parallel routes

EGFR is not the only route from mechanics to ERK.
- Some strain-induced ERK remains with afatinib or force-blind E-cadherin (Houtekamer et al. 2025); stretch activates ERK through Piezo1 and calcium, pushing G2 cells into mitosis (Gudipaty et al. 2017).
- Crowding lowers EGFR/ERK and kills cells (Moreno et al. 2019) — stretch and compaction push ERK in opposite directions.
- Basis: measured; the share of each route inside a spontaneous wave is unknown.

*Gudipaty et al. 2017 — Mechanical stretch triggers rapid epithelial cell division through Piezo1*
  - p. 1: “stretch triggers cells paused in early G2 to activate calcium-dependent ERK1/2 phosphorylation that activates cyclin B transcription necessary to drive cells into mitosis”

*Moreno et al. 2019 — Competition for Space Induces Cell Elimination through Compaction-Driven ERK Downregulation*
  - p. 1: “tissue compaction induces cell elimination through the downregulation of EGFR/ERK pathway and the upregulation of the pro-apoptotic protein Hid”

### Which ligand, how far

Which ligand, and how far does it go? Several, and further than one junction.
- Waves survive the loss of any single ligand; only removing EGF, HB-EGF, TGF-α and EREG together suppresses them (Lin et al. 2022).
- Shed ligand reached receiver cells up to 80 µm away; low-affinity EREG/AREG carry faster (~4 µm/min), longer-range waves than HB-EGF/TGF-α (1–2 µm/min); EREG-null skin waves die out by 200 µm (Deguchi et al. 2024).
- Compression works through the same space: shed ligand concentrates in a collapsing lateral intercellular space (Tschumperlin et al. 2004).
- Basis: measured (knockouts, ligand probes, mouse skin); ligand concentration in the junctional space itself is modelled, not measured.

*Lin et al. 2022 — Redundant roles of EGFR ligands in the ERK activation waves during collective cell migration*
  - p. 1: “ERK activation waves were markedly suppressed, albeit incompletely, only when all four EGFR ligands were knocked out”
  - p. 8: “duration of ERK activation is approximately a half hour both in MDCK cells”

*Deguchi et al. 2024 — Low-affinity ligands of the epidermal growth factor receptor are long-range signal transmitters in collective cell migration of epithelial cells*
  - p. 2: “During collective cell migration, EGFR and extracellular signal-regulated kinase (ERK) activation waves propagate in an a disintegrin and metalloprotease 17 (ADAM17) sheddase- and EGFRL-dependent manner.”
  - p. 5: “mScarlet signals were detected up to 80 μm from HBEGF-ScNeo-expressing producer cells”
  - p. 6: “Low-affinity ligands EREG and AREG showed ERK wave velocities of ~4 μm min−1, approximately four times faster than the high-affinity ligands HBEGF and TGF-α at 1–2 μm min−1”
  - p. 9: “the waves were extinguished at 200 μm or less in Ereg−/− mice, whereas the waves reached more than 800 μm in the WT”

*Tschumperlin et al. 2004 — Mechanotransduction through growth-factor shedding into the extracellular space*
  - From the abstract: "compressive stress shrinks the lateral intercellular space surrounding epithelial cells, and triggers cellular signalling via autocrine binding of epidermal growth factor family ligands" — the junctional-space concentration idea, but for compression. (Author manuscript in PMC, PMC5539413.)

### Other triggers

The same relay starts from dying cells and from Ras/ERK-hyperactive cells.
- Apoptotic cells send ERK/Akt waves to their neighbours through EGFR and MMPs, protecting them for 3–4 h (Gagliardi et al. 2021); in the fly notum the waves stop neighbours dying in clusters (Valon et al. 2021); in human colon monolayers they keep the tissue patterned (Pond et al. 2022).
- Sustained (not pulsatile) oncogenic ERK triggers ADAM17- and EGFR-dependent waves in normal neighbours, which migrate toward the oncogenic cell (Aikin et al. 2020) — the closest match to a RAS–RAF starting point.
- Basis: measured.

*Gagliardi et al. 2021 — Collective ERK/Akt activity waves orchestrate epithelial homeostasis by driving apoptosis-induced survival*
  - p. 1: “We observe waves of Extracellular Signal-Regulated Kinase (ERK) and AKT serine/threonine kinase (Akt) activity pulses that originate from apoptotic cells and propagate radially to healthy surrounding cells.”
  - p. 1: “This requires Epidermal Growth Factor Receptor (EGFR) and matrix metalloproteinase (MMP) signaling.”

*Aikin et al. 2020 — MAPK activity dynamics regulate non-cell autonomous effects of oncogene expression*
  - p. 1: “sustained–but not pulsatile–ERK activity triggers ERK activity waves in unperturbed neighboring cells that depend on the membrane metalloprotease ADAM17 and EGFR activity”
  - p. 1: “the ADAM17-EGFR signaling axis coordinates neighboring cell migration toward oncogenic cells and is required for oncogenic cell extrusion”

*Valon et al. 2021 — Robustness of epithelial sealing is an emerging property of local ERK feedback driven by cell elimination*
  - p. 1: “This protection is driven by a transient activation of ERK in the direct neighbours of extruding cells which reverts caspase activation and prevents elimination of cells in clusters.”

*Pond et al. 2022 — Live-cell imaging in human colonic monolayers reveals ERK waves limit the stem cell compartment to maintain epithelial homeostasis*
  - p. 1: “we discovered that waves of ERK signaling induced by apoptotic cells play a critical role in maintaining tissue patterning and homeostasis”

## H3 · What does the cells' apparent velocity look like as the waves pass?

**Answer: a slow, pulsed drift toward the wave's source.** The signal travels ~1.5–4 µm/min; cells move ~0.3–0.8 µm/min at most; each pass gives stretch → ERK (+3 min) → contraction, about every 90 min, ~20 cells apart. Theory and optogenetics agree that migration is most efficient when the wave runs at ~2 µm/min.

### Wave speed vs cell speed

The signal outruns the cells: ERK waves travel ~1.5–4 µm/min; cells move ≲0.3–0.8 µm/min.
- Mouse skin: SPREADs 1.5 ± 0.3 µm/min, wound trigger waves 1.4 µm/min (Hiratsuka et al. 2015). MDCK: optogenetic mimic at 3 µm/min (Hino et al. 2020); 1–2 µm/min (HB-EGF, TGF-α) to ~4 µm/min (EREG, AREG) (Deguchi et al. 2024). Slower in tissues: ~0.4 µm/min in the cochlear duct (Ishii et al. 2021) (its PDF text renders µm as "mm"), ~10 µm/h in zebrafish scales (De Simone et al. 2021).
- Cells: MDCK monolayer speed falls from 0.8 µm/min to 0 as density rises (Tlili et al. 2018); PtK1 sheets ~0.33 µm/min (Mendoza et al. 2015).
- Basis: measured (FRET biosensors, PIV).

*Hiratsuka et al. 2015 — Intercellular propagation of extracellular signal-regulated kinase activation revealed by in vivo imaging of mouse skin*
  - p. 3: “The mean velocity of the eight SPREADs was 1.5 ± 0.3 μm/min”
  - p. 1: “At the wounded skin, ERK activation propagated as trigger wave in parallel to the wound edge”
  - p. 10: “The velocity of ERK activity propagation was determined as 1.4 μm/min”

*De Simone et al. 2021 — Control of osteoblast regeneration by a train of Erk activity waves*
  - p. 3: “Erk waves travel at a speed in the order of 10 μm h−1, thus one wave traverses the entire scale in about 2 days”

*Ishii et al. 2021 — Retrograde ERK activation waves drive base-to-apex multicellular flow in murine cochlear duct morphogenesis*
  - p. 1: “helical ERK activation propagates from the apex duct tip concomitant with the reverse multicellular flow on the lateral side of the developing cochlear duct, resulting in advection-based duct elongation”
  - p. 5: “oscillatory retrograde ERK activity waves”

*Tlili et al. 2018 — Collective cell migration without proliferation: density determines cell velocity and wave velocity*
  - p. 8: “decreasing from 0.8 µm min−1 to 0 for ¯ρ ranging from 1.8 to 5 × 10−3 µm−2”
  - p. 8: “Their velocity (indicated by the slope of the wave pattern) is of the order of 10 µm min−1, and with a sign opposed to that of the cell velocity”

### One pass of the wave

Each pass: stretch first, ERK ~3 min later, then contraction — about every 90 min.
- ERK activation rate and strain rate oscillate together with a ~90-min period; ERK lags strain by 3 min; waves ~35 µm wide and ~400 µm apart (Hino et al. 2020) (quotes in the Hino 2020 region, H2 column).
- An ERK pulse lasts ~30 min in MDCK (Lin et al. 2022) (20–30 min in single cells, with 1–4 h between pulses (Albeck et al. 2013)).
- Basis: measured (MDCK FRET + strain-rate maps).

*Albeck et al. 2013 — Frequency-modulated pulses of ERK activity transmit quantitative proliferation signals*
  - p. 3: “low concentrations of EGF induced isolated bursts lasting 20–30 minutes (mean 27 minutes) interspersed by dormant periods of 1–4 hours”

### Direction

Net motion is toward the wave's source — against the wave.
- MDCK cells migrate against both wound "tidal" and spontaneous ERK waves; an optogenetic wave alone reproduces it (Aoki et al. 2017).
- Neighbours of a contracting cluster move toward it, opposite the ERK wave (Hino et al. 2020) (quote in the H2 column); normal cells move toward Ras-hyperactive cells (Aikin et al. 2020); cochlear cells flow against helical ERK waves (Ishii et al. 2021).
- Force balance (reasoning, not measured): a CONTRACTING source pulls neighbours toward it — as observed; a SOFTENING source would be stretched by its neighbours, which would relax away from it.

*Aoki et al. 2017 — Propagating Wave of ERK Activation Orients Collective Cell Migration*
  - From the abstract: two ERK waves in MDCK wound healing — a "tidal wave" from the wound and self-organized "spontaneous waves" — and "In both cases, MDCK cells collectively migrated against the direction of the ERK activation wave"; "an optogenetic ERK activation wave reproduced the collective cell migration". No open PDF.

### Models

How fast the cells go depends on how fast the wave goes — fastest near ~2 µm/min.
- Strain ↔ ERK coupling alone predicts wavelengths of 10–18 cells and periods of 50–90 min, and an optimal wave speed of ≈2 µm/min that matches optogenetic experiments (Boocock et al. 2021).
- Migration velocity peaks in resonance with the ERK wave speed (Fukuyama et al. 2025).
- Vertex model: the ratio of active migration force to mechanochemical coupling switches a monolayer between glassy motion and waves (Boocock et al. 2023); reaction–diffusion reproduces the slow zebrafish waves (Hayden et al. 2021).
- Basis: modelled, fitted to MDCK and mouse-skin data.

*Boocock et al. 2021 — Theory of mechanochemical patterning and optimal migration in cell monolayers*
  - p. 1: “patterns can be quantitatively explained by a mechano-chemical coupling between three-dimensional active cellular tensions and the mechano-sensitive ERK/MAPK pathway”
  - p. 10: “demonstrating the existence of an optimal speed for cell movement”
  - p. 10: “suggesting that these systems might be tuned for optimal migration”

*Fukuyama et al. 2025 — Why epithelial cells collectively move against a traveling signal wave*
  - p. 1: “The net motion of the cell population occurred relative to the wave, and the migration velocity showed a maximum in resonance with the velocity of the ERK signal wave.”

*Boocock et al. 2023 — Interplay between mechanochemical patterning and glassy dynamics in cellular monolayers*
  - p. 1: “We show that the relative strength of active migration forces to mechanochemical couplings controls a transition from uniform active glass to periodic spatiotemporal waves.”

*Hayden et al. 2021 — Mathematical modeling of Erk activity waves in regenerating zebrafish scales*
  - p. 1: “Our model shows that this system can be excitable and propagate Erk activity waves.”

## Open questions → experiments

What this canvas cannot answer yet — each is a measurable experiment with TFM + live ERK imaging.
- G-actin, capping protein (CapZ) and retrograde flow during a passing ERK wave: never measured. Flow (speckle / photoactivation) and CapZ or Arp3 imaging in EKAREV-NLS MDCK sheets, aligned to each cell's ERK peak.
- Is the neighbour's strain in a spontaneous wave big enough? Shedding was shown with 18–50% applied stretch; MDCK ERK rises significantly from 30% (Crozet & Levayer 2023). Measure per-cell strain (PIV) and junction tension (monolayer stress microscopy) during waves.
- Which ligand sits in the lateral intercellular space, at what concentration? Modelled for compression (Tschumperlin et al. 2004), never measured in a wave.
- How does E-cadherin tension reach ADAM17 (Src?) — untested (Houtekamer et al. 2025).
- Integrin and Piezo1 routes: ERK still rises with EGFR blocked or force-blind E-cadherin (Houtekamer et al. 2025) (Gudipaty et al. 2017).
- Our direct test of H1 vs the contraction relay: optogenetic RAF in a stripe + TFM — do neighbours move toward the stripe (contraction) or away (breakdown), and does substrate traction fall before or after the junction pulls?

## How this review was built

**A test of the hypothesis, not a search for support.**
- The hypothesis was split into lettered links first; each link was searched for support AND contradiction (5 search angles → 23 sources → 104 claims; 25 checked by three independent verifiers: 17 kept, 8 failed).
- All 8 failures were verifiers who could not open the full text. 5 of them are verbatim in the PDFs on this canvas and are quoted here (e.g. MEK inhibition lowers retrograde flow; a contracting cluster launches waves into its neighbour).
- Every quote was matched word for word on its PDF page; preprint / author-manuscript PDFs are labelled on the card.
- Papers without an open PDF are cards with their key line from the abstract — add the PDF in RM's library (Find PDF or Upload).
- Method notes: CodeLog/Feature requests/FuturePlan_14_literature_review_method.md

## References (35)

- **Aikin et al. 2020** — Aikin TJ, Peterson AF, Pokrass MJ, Clark HR, Regot S. MAPK activity dynamics regulate non-cell autonomous effects of oncogene expression. *Elife 2020;9:e60541*. doi:[10.7554/elife.60541](https://doi.org/10.7554/elife.60541) · PMID 32940599 · open PDF on the canvas
- **Albeck et al. 2013** — Albeck JG, Mills GB, Brugge JS. Frequency-modulated pulses of ERK activity transmit quantitative proliferation signals. *Mol Cell 2013;49(2):249-261*. doi:[10.1016/j.molcel.2012.11.002](https://doi.org/10.1016/j.molcel.2012.11.002) · PMID 23219535 · open PDF on the canvas (author manuscript)
- **Aoki et al. 2017** — Aoki K, Kondo Y, Naoki H, Hiratsuka T, Itoh RE, Matsuda M. Propagating Wave of ERK Activation Orients Collective Cell Migration. *Dev Cell 2017;43(3):305-317.e5*. doi:[10.1016/j.devcel.2017.10.016](https://doi.org/10.1016/j.devcel.2017.10.016) · PMID 29112851 · no open PDF — add in RM (Find PDF / Upload)
- **Boocock et al. 2021** — Boocock D, Hino N, Ruzickova N, Hirashima T, Hannezo E. Theory of mechanochemical patterning and optimal migration in cell monolayers. *Nat Phys 2021;17(2):267-274*. doi:[10.1038/s41567-020-01037-7](https://doi.org/10.1038/s41567-020-01037-7) · open PDF on the canvas (preprint)
- **Boocock et al. 2023** — Boocock D, Hirashima T, Hannezo E. Interplay between mechanochemical patterning and glassy dynamics in cellular monolayers. *PRX Life 2023;1(1):013001*. doi:[10.1103/prxlife.1.013001](https://doi.org/10.1103/prxlife.1.013001) · open PDF on the canvas (preprint)
- **Crozet & Levayer 2023** — Crozet F, Levayer R. Emerging roles and mechanisms of ERK pathway mechanosensing. *Cell Mol Life Sci 2023;80(12):355*. doi:[10.1007/s00018-023-05007-z](https://doi.org/10.1007/s00018-023-05007-z) · PMID 37947896 · open PDF on the canvas
- **De Simone et al. 2021** — De Simone A, Evanitsky MN, Hayden L, Cox BD, Wang J, Tornini VA, et al. Control of osteoblast regeneration by a train of Erk activity waves. *Nature 2021;590(7844):129-133*. doi:[10.1038/s41586-020-03085-8](https://doi.org/10.1038/s41586-020-03085-8) · PMID 33408418 · open PDF on the canvas (author manuscript)
- **Deguchi et al. 2024** — Deguchi E, Lin S, Hirayama D, Matsuda K, Tanave A, Sumiyama K, et al. Low-affinity ligands of the epidermal growth factor receptor are long-range signal transmitters in collective cell migration of epithelial cells. *Cell Rep 2024;43(11):114986*. doi:[10.1016/j.celrep.2024.114986](https://doi.org/10.1016/j.celrep.2024.114986) · PMID 39546398 · open PDF on the canvas (author manuscript)
- **Fukuyama et al. 2025** — Fukuyama T, Ebata H, Yamamoto A, Ienaga R, Kondo Y, Tanaka M, et al. Why epithelial cells collectively move against a traveling signal wave. *Soft Matter 2025;21(40):7881-7894*. doi:[10.1039/d5sm00403a](https://doi.org/10.1039/d5sm00403a) · open PDF on the canvas (preprint (arXiv))
- **Gagliardi et al. 2021** — Gagliardi PA, Dobrzyński M, Jacques MA, Dessauges C, Ender P, Blum Y, et al. Collective ERK/Akt activity waves orchestrate epithelial homeostasis by driving apoptosis-induced survival. *Dev Cell 2021;56(12):1712-1726.e6*. doi:[10.1016/j.devcel.2021.05.007](https://doi.org/10.1016/j.devcel.2021.05.007) · PMID 34081908 · open PDF on the canvas (preprint)
- **Glading et al. 2004** — Glading A, Bodnar RJ, Reynolds IJ, Shiraha H, Satish L, Potter DA, et al. Epidermal growth factor activates m-calpain (calpain II), at least in part, by extracellular signal-regulated kinase-mediated phosphorylation. *Mol Cell Biol 2004;24(6):2499-2512*. doi:[10.1128/mcb.24.6.2499-2512.2004](https://doi.org/10.1128/mcb.24.6.2499-2512.2004) · PMID 14993287 · open PDF on the canvas
- **Gudipaty et al. 2017** — Gudipaty SA, Lindblom J, Loftus PD, Redd MJ, Edes K, Davey CF, et al. Mechanical stretch triggers rapid epithelial cell division through Piezo1. *Nature 2017;543(7643):118-121*. doi:[10.1038/nature21407](https://doi.org/10.1038/nature21407) · PMID 28199303 · open PDF on the canvas (author manuscript)
- **Han et al. 2007** — Han MY, Kosako H, Watanabe T, Hattori S. Extracellular signal-regulated kinase/mitogen-activated protein kinase regulates actin organization and cell motility by phosphorylating the actin cross-linking protein EPLIN. *Mol Cell Biol 2007;27(23):8190-8204*. doi:[10.1128/mcb.00661-07](https://doi.org/10.1128/mcb.00661-07) · PMID 17875928 · open PDF on the canvas
- **Hayden et al. 2021** — Hayden LD, Poss KD, De Simone A, Di Talia S. Mathematical modeling of Erk activity waves in regenerating zebrafish scales. *Biophys J 2021;120(19):4287-4297*. doi:[10.1016/j.bpj.2021.05.004](https://doi.org/10.1016/j.bpj.2021.05.004) · PMID 34022234 · open PDF on the canvas (preprint)
- **Hino et al. 2020** — Hino N, Rossetti L, Marín-Llauradó A, Aoki K, Trepat X, Matsuda M, et al. ERK-Mediated Mechanochemical Waves Direct Collective Cell Polarization. *Dev Cell 2020;53(6):646-660.e8*. doi:[10.1016/j.devcel.2020.05.011](https://doi.org/10.1016/j.devcel.2020.05.011) · PMID 32497487 · open PDF on the canvas (preprint)
- **Hiratsuka et al. 2015** — Hiratsuka T, Fujita Y, Naoki H, Aoki K, Kamioka Y, Matsuda M. Intercellular propagation of extracellular signal-regulated kinase activation revealed by in vivo imaging of mouse skin. *Elife 2015;4:e05178*. doi:[10.7554/elife.05178](https://doi.org/10.7554/elife.05178) · PMID 25668746 · open PDF on the canvas
- **Houtekamer et al. 2025** — Houtekamer RM, van der Net MC, Vliem MJ, Noordzij TEJC, van Uden L, van Es RM, et al. E-cadherin mechanotransduction activates EGFR-ERK signaling in epithelial monolayers by inducing ADAM-mediated ligand shedding. *Sci Signal 2025;18(886):eadr7926*. doi:[10.1126/scisignal.adr7926](https://doi.org/10.1126/scisignal.adr7926) · PMID 40359261 · open PDF on the canvas (preprint)
- **Ishii et al. 2021** — Ishii M, Tateya T, Matsuda M, Hirashima T. Retrograde ERK activation waves drive base-to-apex multicellular flow in murine cochlear duct morphogenesis. *Elife 2021;10:e61092*. doi:[10.7554/elife.61092](https://doi.org/10.7554/elife.61092) · PMID 33667159 · open PDF on the canvas
- **Klemke et al. 1997** — Klemke RL, Cai S, Giannini AL, Gallagher PJ, de Lanerolle P, Cheresh DA. Regulation of cell motility by mitogen-activated protein kinase. *J Cell Biol 1997;137(2):481-492*. doi:[10.1083/jcb.137.2.481](https://doi.org/10.1083/jcb.137.2.481) · PMID 9128257 · open PDF on the canvas
- **Lin et al. 2022** — Lin S, Hirayama D, Maryu G, Matsuda K, Hino N, Deguchi E, et al. Redundant roles of EGFR ligands in the ERK activation waves during collective cell migration. *Life Sci Alliance 2022;5(1):e202101206*. doi:[10.26508/lsa.202101206](https://doi.org/10.26508/lsa.202101206) · PMID 34667080 · open PDF on the canvas
- **Matsubayashi et al. 2004** — Matsubayashi Y, Ebisuya M, Honjoh S, Nishida E. ERK activation propagates in epithelial cell sheets and regulates their migration during wound healing. *Curr Biol 2004;14(8):731-735*. doi:[10.1016/j.cub.2004.03.060](https://doi.org/10.1016/j.cub.2004.03.060) · PMID 15084290 · no open PDF — add in RM (Find PDF / Upload)
- **Mendoza et al. 2011** — Mendoza MC, Er EE, Zhang W, Ballif BA, Elliott HL, Danuser G, et al. ERK-MAPK drives lamellipodia protrusion by activating the WAVE2 regulatory complex. *Mol Cell 2011;41(6):661-671*. doi:[10.1016/j.molcel.2011.02.031](https://doi.org/10.1016/j.molcel.2011.02.031) · PMID 21419341 · no open PDF — add in RM (Find PDF / Upload)
- **Mendoza et al. 2015** — Mendoza MC, Vilela M, Juarez JE, Blenis J, Danuser G. ERK reinforces actin polymerization to power persistent edge protrusion during motility. *Sci Signal 2015;8(377):ra47*. doi:[10.1126/scisignal.aaa8859](https://doi.org/10.1126/scisignal.aaa8859) · PMID 25990957 · open PDF on the canvas (author manuscript)
- **Moreno et al. 2019** — Moreno E, Valon L, Levillayer F, Levayer R. Competition for Space Induces Cell Elimination through Compaction-Driven ERK Downregulation. *Curr Biol 2019;29(1):23-34.e8*. doi:[10.1016/j.cub.2018.11.007](https://doi.org/10.1016/j.cub.2018.11.007) · PMID 30554899 · open PDF on the canvas (preprint)
- **Nguyen et al. 1999** — Nguyen DH, Catling AD, Webb DJ, Sankovic M, Walker LA, Somlyo AV, et al. Myosin light chain kinase functions downstream of Ras/ERK to promote migration of urokinase-type plasminogen activator-stimulated cells in an integrin-selective manner. *J Cell Biol 1999;146(1):149-164*. doi:[10.1083/jcb.146.1.149](https://doi.org/10.1083/jcb.146.1.149) · PMID 10402467 · open PDF on the canvas
- **Ogura et al. 2018** — Ogura Y, Wen FL, Sami MM, Shibata T, Hayashi S. A Switch-like Activation Relay of EGFR-ERK Signaling Regulates a Wave of Cellular Contractility for Epithelial Invagination. *Dev Cell 2018;46(2):162-172.e5*. doi:[10.1016/j.devcel.2018.06.004](https://doi.org/10.1016/j.devcel.2018.06.004) · PMID 29983336 · no open PDF — add in RM (Find PDF / Upload)
- **Pond et al. 2022** — Pond KW, Morris JM, Alkhimenok O, Varghese RP, Cabel CR, Ellis NA, et al. Live-cell imaging in human colonic monolayers reveals ERK waves limit the stem cell compartment to maintain epithelial homeostasis. *Elife 2022;11:e78837*. doi:[10.7554/elife.78837](https://doi.org/10.7554/elife.78837) · PMID 36094159 · open PDF on the canvas
- **Pritchard et al. 2004** — Pritchard CA, Hayes L, Wojnowski L, Zimmer A, Marais RM, Norman JC. B-Raf acts via the ROCKII/LIMK/cofilin pathway to maintain actin stress fibers in fibroblasts. *Mol Cell Biol 2004;24(13):5937-5952*. doi:[10.1128/mcb.24.13.5937-5952.2004](https://doi.org/10.1128/mcb.24.13.5937-5952.2004) · PMID 15199148 · no open PDF — add in RM (Find PDF / Upload)
- **Sahai et al. 2001** — Sahai E, Olson MF, Marshall CJ. Cross-talk between Ras and Rho signalling pathways in transformation favours proliferation and increased motility. *EMBO J 2001;20(4):755-766*. doi:[10.1093/emboj/20.4.755](https://doi.org/10.1093/emboj/20.4.755) · PMID 11179220 · open PDF on the canvas
- **Samson et al. 2019** — Samson SC, Elliott A, Mueller BD, Kim Y, Carney KR, Bergman JP, et al. p90 ribosomal S6 kinase (RSK) phosphorylates myosin phosphatase and thereby controls edge dynamics during cell migration. *J Biol Chem 2019;294(28):10846-10862*. doi:[10.1074/jbc.ra119.007431](https://doi.org/10.1074/jbc.ra119.007431) · PMID 31138649 · open PDF on the canvas
- **Samson et al. 2022** — Samson SC, Khan AM, Mendoza MC. ERK signaling for cell migration and invasion. *Front Mol Biosci 2022;9:998475*. doi:[10.3389/fmolb.2022.998475](https://doi.org/10.3389/fmolb.2022.998475) · PMID 36262472 · open PDF on the canvas
- **Tlili et al. 2018** — Tlili S, Gauquelin E, Li B, Cardoso O, Ladoux B, Delanoë-Ayari H, et al. Collective cell migration without proliferation: density determines cell velocity and wave velocity. *R Soc Open Sci 2018;5(5):172421*. doi:[10.1098/rsos.172421](https://doi.org/10.1098/rsos.172421) · PMID 29892428 · open PDF on the canvas
- **Tschumperlin et al. 2004** — Tschumperlin DJ, Dai G, Maly IV, Kikuchi T, Laiho LH, McVittie AK, et al. Mechanotransduction through growth-factor shedding into the extracellular space. *Nature 2004;429(6987):83-86*. doi:[10.1038/nature02543](https://doi.org/10.1038/nature02543) · PMID 15103386 · no open PDF — add in RM (Find PDF / Upload)
- **Valon et al. 2021** — Valon L, Davidović A, Levillayer F, Villars A, Chouly M, Cerqueira-Campos F, et al. Robustness of epithelial sealing is an emerging property of local ERK feedback driven by cell elimination. *Dev Cell 2021;56(12):1700-1711.e8*. doi:[10.1016/j.devcel.2021.05.006](https://doi.org/10.1016/j.devcel.2021.05.006) · PMID 34081909 · open PDF on the canvas (preprint)
- **Webb et al. 2004** — Webb DJ, Donais K, Whitmore LA, Thomas SM, Turner CE, Parsons JT, et al. FAK-Src signalling through paxillin, ERK and MLCK regulates adhesion disassembly. *Nat Cell Biol 2004;6(2):154-161*. doi:[10.1038/ncb1094](https://doi.org/10.1038/ncb1094) · PMID 14743221 · no open PDF — add in RM (Find PDF / Upload)

---
35 papers · 28 open PDFs · 65 verbatim quotes, each matched word for word on its PDF page (page numbers are the PDF's own pages; preprint and author-manuscript pages differ from the journal's).
