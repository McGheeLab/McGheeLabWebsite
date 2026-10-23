#!/usr/bin/env node
/* seed_onr_associations.js
 *
 * Wire the AWARDED ONR grant into the research map.
 *
 * `researchFoci/toward-the-development-of-a-periodic-table-of-tissue-thermom`
 * already exists — status `awarded`, award number 3062920, period
 * 2026-04-01 → 2029-04-02 — but with completely empty `links`. It hangs off
 * nothing, has no aims, and has no pointer to the document it was won with.
 * This script fills that in from the submitted technical volume at
 * Data/Grants/ONR Technical Proposal.docx (imported into the paper builder by
 * scripts/onr_bundle/, which is a prerequisite — see PRE-FLIGHT below).
 *
 * The graph it builds — children point UP, parents are always derived
 * (rm/js/research-data.js PARENTS / LINK_KEY):
 *
 *     specialty thermomechanics (NEW)    specialty tfm (existing)
 *              └───────────┬──────────────────────┘
 *              concept tissue-thermomechanics (NEW)
 *                          └── grant  toward-…-thermom   [awarded, EXISTS]
 *                                ├── aim onr-aim-1 / -2 / -3   [planning]
 *                                └── ref_source → the imported draft
 *
 * V3.721 note: there is no longer a `reference`-level card. The bibliography
 * lives ON the grant as `ref_source: {kind:'draft_citations', draft_id}` and
 * research-references.js reads the library live, so nothing is copied and a
 * citation added in the builder later shows up with no re-sync.
 *
 * The one subtlety worth knowing: the paper importer stamps
 * meta.library.linked_drafts, but research-references.js filters on
 * meta.library.cited_in_drafts — a field only CITED_SYNC writes, ~16 s after
 * someone opens the draft in the editor. So step 5 stamps it directly, or the
 * grant's References section renders zero rows until the draft is opened.
 * Stamping is safe: CITED_SYNC re-scans before removing anything and the body
 * cites all 33, so it converges rather than reverting.
 *
 * Usage:
 *   node scripts/seed_onr_associations.js            # dry run, writes nothing
 *   node scripts/seed_onr_associations.js --commit
 *
 * Prerequisites: npm install firebase-admin, plus scripts/service-account.json
 * (gitignored) or GOOGLE_APPLICATION_CREDENTIALS.
 *
 * Idempotent: existing cards are skipped, not overwritten; the grant patch and
 * the cited_in_drafts stamps are arrayUnion / merge, so a re-run after a
 * partial failure finishes the job without duplicating anything.
 */

const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');

const COMMIT = process.argv.includes('--commit');
const GRANT_ID = 'toward-the-development-of-a-periodic-table-of-tissue-thermom';
const DRAFT_TITLE = ('Towards the Development of a Periodic Table of Quasistatic '
                     + 'Tissue Mechanical Properties');
const SPECIALTY_ID = 'thermomechanics';
const CONCEPT_ID = 'tissue-thermomechanics';
const TFM_ID = 'tfm';

/* ── content ──────────────────────────────────────────────────────
 * Transcribed from the submitted volume: §1 (Introduction and Objectives),
 * §2.2 (CTE background), §3.1–3.3 (the three aims, their evaluation plans,
 * expected outcomes and risks). Nothing here is invented.
 * Templates mirror research-composer.js TEMPLATES so each card opens in the
 * guided editor with every prompt already answered. */

const TEMPLATES = {
  specialty: [
    ['what_is_it', 'What it is'],
    ['uniquely_ours', 'What makes it ours'],
    ['what_it_enables', 'What it enables'],
  ],
  concept: [
    ['vision', 'The vision'],
    ['why_it_matters', 'Why it matters'],
    ['which_specialties', 'How we attack it'],
    ['open_questions', 'Open questions'],
  ],
  grant: [
    ['aims_sketch', 'Aims sketch'],
    ['significance', 'Significance'],
    ['innovation', 'Innovation'],
    ['agency_fit', 'Fit'],
  ],
  aim: [
    ['target_result', 'Target result'],
    ['how_we_know', 'How we’ll know'],
    ['feeds', 'What it feeds'],
    ['risks', 'Risks'],
  ],
};

const SPECIALTY_ANSWERS = {
  what_is_it:
    'Measuring what temperature does to soft tissue — how it expands, how its stiffness and damping shift, and when heating stops being reversible — as full-field maps rather than a single bulk number.\n\n' +
    'A microscope-compatible chamber driven by two Peltier elements holds the sample in one of two modes: uniform, where both elements set one bath temperature, and gradient, where opposing walls are held at different setpoints to impose a near-linear lateral temperature field across the tissue. A thermistor array at the sample plane closes the loop. Image correlation of surface-bound tracer beads turns the resulting motion into strain fields, and strain regressed against local ΔT gives the coefficient of thermal expansion at every point.',
  uniquely_ours:
    'Three departures from how this has been done before.\n\n' +
    'We work at and above body temperature. Published tissue CTE was collected at 20–35 °C, exactly where the behavior turns nonlinear, so it says little about 37 °C, transient exposure, or cyclic heating. Brain tissue in particular expands markedly more near physiologic temperature than the linear approximations predict.\n\n' +
    'We map instead of averaging. Tissue is a composite: liver already shows different expansion in vasculature-rich versus parenchymal zones, and fibrous tissue should require a tensorial rather than a scalar CTE — a claim that has been modeled but never experimentally verified.\n\n' +
    'We measure damage rather than assuming a threshold. Cyclic thermo-mechanical hysteresis, an Arrhenius thermal dose, and post-cycle micro-rheology together give a calibrated damage index and an onset temperature, instead of one number quoted from a table.',
  what_it_enables:
    'The thermal half of a tissue property atlas: temperature-indexed moduli, loss factors, and tensorial CTE fields that a simulation can actually consume, each with a stated noise floor and repeatability.\n\n' +
    'Operationally, it produces thermal-dose thresholds — the temperature and exposure duration at which a tissue changes irreversibly — which is the number that governs radiofrequency and microwave ablation, laser therapy, and image-guided hyperthermia, and which is currently guessed at.',
};

const CONCEPT_ANSWERS = {
  vision:
    'A “Periodic Table of Tissue Mechanical Properties”: a spatially resolved reference in which local composition and architecture — the relative abundance of collagen I/III/IV, elastin, laminin and proteoglycans, plus fiber alignment, porosity and layering — predict local quasistatic moduli, viscoelastic spectra and thermomechanical coefficients.\n\n' +
    'If it works, composition and structure become continuously predictive variables rather than lookup constants, and material properties can be assigned a priori wherever histology or imaging is known. In-silico organs stop being cartoons tuned by averages and become mechanistically grounded digital tissue.',
  why_it_matters:
    'Solvers have outrun their inputs. High-fidelity multiphysics simulation can now resolve microstructural stress fields and predict failure modes, but only if the input parameters describe real tissue — and today those parameters are bulk-averaged, sparsely sampled, divorced from native architecture, and collected below physiologic temperature. The bottleneck is the data, not the mathematics.\n\n' +
    'Lumping a heterogeneous, anisotropic tissue into one averaged response misrepresents its stress–strain behavior outright: white matter is 30–40% stiffer than grey, kidney stiffness is directional with tubule orientation, and a vessel wall is a layered composite. The consequences are practical — injury prediction and protective design for the Navy at one end, thermal-therapy planning at the other.',
  which_specialties:
    'Two of ours, combined.\n\n' +
    'Traction Force Microscopy supplies the measurement spine: image correlation of dense fiducials into full-field displacement and strain, and the inverse recovery of material parameters from those fields. Here it is turned outward — from cells pulling on a substrate to a calibrated magnetic field pulling on beads covalently bound to a tissue surface, with no probe touching the sample.\n\n' +
    'Thermomechanics supplies the second axis: a Peltier-regulated stage chamber in uniform and gradient modes, tensorial CTE fields, temperature-indexed moduli, and a calibrated thermal-damage index.\n\n' +
    'A third leg is compositional rather than mechanical — SERS and immunofluorescence on a book-matched countersurface — which is what lets a mechanical map be attributed to an ECM makeup instead of merely correlated with a location.',
  open_questions:
    'Where is the irreversible threshold? Heating above some critical temperature causes hysteretic, permanent change through protein denaturation, but that threshold is unknown per tissue, and it is a dose (temperature × time), not a temperature.\n\n' +
    'Is thermal anisotropy real? Directional CTE in fibrous tissue has been modeled computationally and never measured, so whether a tensorial representation is required is still open.\n\n' +
    'Do the elements transfer? The central bet is that a collagen-rich aligned bundle behaves the same way in muscle as in kidney capsule — that a manageable number of compositional motifs, perhaps a dozen, describes most tissue microenvironments across organs. If they do not transfer, the table is a catalogue rather than a periodic table.\n\n' +
    'And how much can a stiffness map be trusted as a material property? A constrained region expands less because its neighbours resist it, not because its CTE differs — separating true material behavior from geometric constraint is an open measurement problem, not just an analysis one.',
};

/* The GRANT card's own content.
 *
 * This card existed on the map when this script was written — level 'grant',
 * status 'awarded', abbr ONR, award number 3062920, period 2026-04-01 →
 * 2029-04-02 — and was deleted from Firestore partway through the session that
 * built the bundle. The four answers below are exactly what it carried
 * (recovered verbatim from the live doc), so the restore path reproduces it
 * rather than paraphrasing the proposal a second time.
 *
 * If the card is present, NONE of this is used: the script patches links and
 * ref_source and leaves title, status, grant_meta and description alone. */
const GRANT_ANSWERS = {
  aims_sketch:
    'We will build a spatially resolved atlas of quasistatic tissue mechanics and link it to extracellular matrix (ECM) composition. Aim 1 develops non-contact micro-rheology: magnetic microbeads covalently coupled to surface ECM are actuated by a programmable Helmholtz/Maxwell coil pair, and tracer-bead image correlation drives inverse finite-element recovery of modulus and viscoelastic maps. Aim 2 adds a Peltier-regulated bath imposing uniform and gradient thermal boundary conditions, yielding tensorial coefficient of thermal expansion fields, temperature-indexed moduli, and a calibrated thermal-damage index. Aim 3 book-matches the opposing tissue face, quantifies composition and fiber orientation by SERS and immunofluorescence, and co-registers these maps to define biomechanical elements.',
  significance:
    'Organ-scale simulation now resolves microstructural stress fields, but its input parameters do not. Reported tissue properties are bulk-averaged, sparsely sampled, measured at sub-physiologic temperatures, and divorced from native architecture, so exquisite solvers are fed data that cannot support their resolution. Thermomechanics is nearly absent: coefficients of thermal expansion have been collected at 20 to 30 degrees Celsius, ignoring body temperature, transient exposure, and cyclic loading. By measuring modulus, viscoelastic spectra, and thermal expansion where they originate, within heterogeneous anisotropic microarchitecture, and by tying each value to local ECM makeup, we convert composition and structure into predictive variables and make digital tissues mechanistically grounded.',
  innovation:
    'Four departures define this work. First, loading is applied without a probe: calibrated magnetic fields actuate surface-bound beads, eliminating the contact artifacts, boundary effects, and homogeneity assumptions that bias indentation, rheometry, and elastography. Second, thermomechanical mapping spans physiologic and damaging temperatures, delivering the first spatially resolved, tensorial CTE fields and a hysteresis-based thermal-damage threshold rather than a single scalar. Third, the book-matched sectioning method preserves one tested face and its mirror image, enabling voxel-wise registration of mechanics to SERS and immunofluorescence composition. Fourth, we reframe tissue as combinations of compositional elements, replacing organ-by-organ tabulation with transferable structure-function rules.',
  agency_fit:
    'The effort directly serves ONR Code 34, Warfighter Protection and Applications (Division 342), and its objective of understanding and preventing injury. High-fidelity human-response models lack exactly what we deliver: anisotropy tensors, temperature-indexed viscoelastic parameters, tensorial CTE fields, and calibrated damage metrics, each with quantified noise floors, repeatability, and confidence bounds. Products are packaged as inverse-FEM-assimilated property maps, lookup tables, and reference subroutines for direct ingestion by Navy toolchains, supporting injury risk functions, PPE and restraint design trades, and mission-profile hazard assessment. The same thresholds govern therapeutic ultrasound, radiofrequency and laser ablation, and image-guided hyperthermia, improving treatment planning and triage in austere naval settings.',
};

const GRANT_CARD = {
  level: 'grant',
  title: 'Toward the Development of a Periodic Table of Tissue Thermomechanical Properties',
  abbr: 'ONR',
  icon: '\u{1F9F2}',
  color: '#6d8fd9',
  one_liner: 'Mechanical characterization of tissue via magnetic actuation',
  status: 'awarded',
  status_source: 'manual',
  grant_meta: {
    agency: 'ONR', mechanism: 'Code 34',
    submit_to: '', submission_url: '', target_deadline: 'TBD',
    award_number: '3062920',
    period_start: '2026-04-01', period_end: '2029-04-02',
  },
};

const AIMS = [
  {
    id: 'onr-aim-1',
    title: 'Aim 1 — Spatially mapped non-contact mechanical testing',
    abbr: 'Aim 1',
    one_liner: 'Actuate covalently bound magnetic microparticles with a calibrated electromagnet and invert the tracked bead motion into local mechanical property maps.',
    answers: {
      target_result:
        'A microscope-mounted mechanical testing platform that combines magnetic force actuation with image-correlation deformation tracking, together with a validated standard operating procedure for using it on soft tissue — sample preparation, per-tissue parameter settings, calibration, and analysis.\n\n' +
        'Scientifically: the first-generation spatially resolved mechanical property maps for the target tissues, showing how stiffness is distributed within a sample and quantifying heterogeneity that was previously unmeasured.\n\n' +
        'The mechanism is non-contact by construction. A Helmholtz pair in a Maxwell configuration produces a uniform, programmable field with an approximately linear gradient over roughly 0.3–0.4 coil diameters, acting on magnetic microparticles covalently bound to the tissue surface. There is no probe, so no contact artifact, no boundary effect, and no homogeneity assumption.',
      how_we_know:
        'Phantom verification first. Hydrogels whose constitutive models are independently characterized by rheometry (PAAm as quadratic Kelvin–Voigt, gelatin as neo-Hookean Kelvin–Voigt, agarose as poroelastic Biot) are cast with fluorescent magnetic and non-magnetic inclusions, loaded incrementally, and inverted. Acceptance criteria are stated in advance: recover 10, 20 and 50 kPa within ±10%, detect a ≥2× stiffness contrast down to the target mapping resolution, and demonstrate SNR sufficient for stable property inversion.\n\n' +
        'Then tissue, against the literature. Local moduli are spatially averaged over a region comparable to a bulk test and compared with published bulk values for that tissue, across multiple tissue types and stiffness levels.\n\n' +
        'Then statistics. Accuracy from phantom error, precision from test–retest coefficient of variation, and spatial resolution bracketed by inclusion size (a detectable 50 µm inclusion and an undetectable 10 µm one bracket the limit), reported with confidence intervals via Bland–Altman and ANOVA.',
      feeds:
        'Everything downstream. Aim 2 reuses this actuation and the same beads inside the thermal chamber, so its temperature-indexed moduli are the Aim 1 measurement repeated at setpoints. Aim 3 correlates these property maps, voxel by voxel, against composition measured on the book-matched face.\n\n' +
        'The microindentation and inverse-FEM stiffness recovered here is also what converts every later bead displacement into a stress.',
      risks:
        'Insufficient magnetic force, or lower bead susceptibility than specified — the drive may not lift bead forces above the imaging noise floor. The force budget is pushed along the known scaling (force goes as the cube of bead diameter and the square of coil current): reduce coil radius, increase amp-turns within thermal limits, optimize waveforms for lock-in detection, and manage heat with high-fill windings, heat-sunk bobbins and forced cooling. Higher-loading or slightly larger beads gain a lot because of the d³ dependence. A compact Maxwell gradient stage with cored pole pieces is the contingency for more force.\n\n' +
        'Incomplete or unstable bead coupling — weak covalent attachment causes signal loss or detachment under repeated actuation. Move from NHS–amine to higher-yield chemistry (EDC/NHS, thiol–Michael, silanization or catechol primers), verify adhesion under bath conditions with step-load and cyclic tests, and keep peak loads below a conservative fraction of the modeled bond-rupture limit.',
    },
  },
  {
    id: 'onr-aim-2',
    title: 'Aim 2 — Thermomechanical response under quasi-static loading',
    abbr: 'Aim 2',
    one_liner: 'Add a Peltier-regulated bath in uniform and gradient modes to produce tensorial CTE fields, temperature-indexed moduli, and a calibrated thermal-damage index.',
    answers: {
      target_result:
        'The first measurements of tissue coefficient of thermal expansion at physiologic temperature, with spatial detail, focusing on porcine brain and liver — full-field maps rather than one bulk scalar, expected to show that tissue is not thermally uniform (grey versus white matter; elastin-rich versus collagen-rich vessel wall).\n\n' +
        'A characterization of irreversible response from cyclic testing over 30–70 °C: the critical thermal dose — temperature and exposure duration — beyond which a tissue changes permanently, expected to appear as residual contraction or a drop in post-cooling CTE as protein denaturation sets in around 60–70 °C.\n\n' +
        'And the first spatial maps of thermal expansion showing anisotropy directly, including circumferential versus longitudinal expansion in vessel wall, which has never been experimentally mapped in a thermal context.',
      how_we_know:
        'Phantoms with known, isotropic CTE first: a calibration gel subjected to a 10 °C rise should produce a uniform strain of the predicted magnitude, repeated across phantoms spanning a range of expansion coefficients to establish linearity. Small inclusions of a differing-CTE hydrogel set the spatial resolution — the smallest resolvable heterogeneity is defined by what the map actually recovers.\n\n' +
        'Then tissue at discrete setpoints (37, 40, 45, 50 °C), verified by the in-plane thermistor array, running the full Aim 1 micro-rheology battery — step, ramp, small-amplitude oscillatory shear, low-bias normal loading, and multi-directional shear in 15–30° increments — and fitting the same model library with temperature-dependent parameters. Anisotropic regions get a 2D in-plane compliance tensor assembled from at least three non-collinear shear orientations.\n\n' +
        'Damage is measured, not assumed: thermal hysteresis over a closed cycle, residual strain fraction, storage-modulus loss and anisotropy degradation combine into a composite damage index, with an Arrhenius thermal dose Ω(T,t) translating it into operational thresholds.',
      feeds:
        'The thermal axis of the atlas, and the temperature-indexed inputs the collaboration needs: co-registered strain, temperature and property fields pass to the Upadhyay machine-learning pipeline for composition-to-behavior fingerprinting, and the same thresholds govern therapeutic ultrasound, RF and laser ablation, and image-guided hyperthermia.\n\n' +
        'Aim 3 uses these maps alongside the Aim 1 mechanics when it correlates against composition.',
      risks:
        'Low, because the core workflow already exists in the lab — but two things need watching.\n\n' +
        'Constraint masquerading as material property. A stiffer or structurally constrained region may expand less because the surrounding matrix resists it, not because its CTE differs. Mitigated by correlating CTE maps against the Aim 3 architecture maps, so structural context distinguishes true material behavior from mechanical coupling, and by a plane-stress thermoelastic relation with a lightweight FE forward model where geometry introduces coupling.\n\n' +
        'Optical distortion through a heated bath. Refractive-index changes and convection warp the optical path and add DIC noise. The sample sits on a thin inert hydrogel bed it can slide on without friction, with granulated hydrogel above to hold it laterally while letting it change volume — which damps convection and stabilizes the imaging window. Recirculation is disabled in gradient mode to preserve 1-D conduction.',
    },
  },
  {
    id: 'onr-aim-3',
    title: 'Aim 3 — Microstructure correlation to define biomechanical elements',
    abbr: 'Aim 3',
    one_liner: 'Book-match the tested face, quantify composition and fiber orientation by SERS and immunofluorescence, and co-register to define transferable biomechanical elements.',
    answers: {
      target_result:
        'A set of biomechanical tissue elements — the analogues of chemical elements — that categorize tissue regions by makeup and mechanical behavior, expected to be a manageable number (perhaps a dozen or fewer) covering most tissue microenvironments: a basement-membrane–dominated element (high collagen IV and laminin, moderate isotropic stiffness), a fiber-dominated connective element (high collagen I, aligned, stiff and anisotropic), a soft cell-rich matrix element (low ECM, very compliant).\n\n' +
        'With them, explicit spatially mapped correlations between microarchitecture and mechanics, and quantitative evidence that composition and architecture predict local properties — a multivariate model over the measured ECM features explaining a significant share of the variability in local stiffness.\n\n' +
        'The deliverable is the reference chart itself: elements on one axis, mechanical parameters on the other, populated with measured values.',
      how_we_know:
        'The “matchbook” method is the enabling trick: the tissue is marked and sectioned so one face carries the mechanically tested surface and the opposite face exposes its mirror image, with vessel branch points, pigment spots and deliberately placed micro-markers as shared fiducials. Alignment accuracy is held below 50 µm and verified by sequential imaging of intact and sectioned surfaces.\n\n' +
        'Composition comes from two complementary modalities on that face: surface-enhanced confocal Raman for label-free relative abundance of ECM constituents, calibrated against a reference library of purified collagen I, elastin and gelatin and against phantoms of known ratio; and an immunofluorescence panel (collagen I, III, IV, laminin, elastin, DAPI, phalloidin) for specificity. The two are cross-validated against each other by pixel-wise correlation.\n\n' +
        'Then pointwise correlation per pixel or superpixel — mechanical descriptors against structural features — with regression and simple machine learning (PCA, random forests), clustering into elements, and held-out validation testing whether knowing a region’s category predicts its properties.',
      feeds:
        'This is where the atlas stops being a table of organs and becomes a set of rules. It is the deliverable the whole program is named for, and the input the collaborators’ machine-learning models generalize from to untested tissues.\n\n' +
        'It also feeds back into Aim 2: the architecture maps are what separate a genuinely low-CTE region from one that is merely constrained.',
      risks:
        'Topological matching may fail. Fixation, sectioning and staining deform, shrink or tear tissue, and the maps may not overlay confidently. Fallback is region-based correlation — partition into larger anatomical regions identifiable in both datasets and compare averages there. Less data, still meaningful.\n\n' +
        'The imaging may miss the thing that matters. A minor component outside the antibody panel could stiffen the tissue, and Raman may not separate spectrally similar proteins such as collagen I from collagen III. The two modalities were chosen to cover each other (immunohistochemistry specific, Raman holistic); a mechanically stiff region with no collagen or elastin signal triggers additional stains or another modality — second-harmonic generation for unstained collagen, or mass-spectrometry imaging or FTIR as a compositional cross-check.',
    },
  },
];

/* ── helpers ──────────────────────────────────────────────────────
 * esc + compile are byte-for-byte research-composer.js compileDescription(),
 * so re-compiling in the browser produces identical HTML and nothing shifts
 * under the PI. */

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function compile(template, answers) {
  return template.map(([key, heading]) => {
    const a = (answers[key] || '').trim();
    if (!a) return '';
    const paras = a.split(/\n{2,}/).map(p => '<p>' + esc(p.trim()).replace(/\n/g, '<br>') + '</p>').join('');
    return '<h3>' + esc(heading) + '</h3>' + paras;
  }).filter(Boolean).join('');
}

function emptyLinks() {
  return {
    specialty_ids: [], concept_ids: [], grant_ids: [], aim_ids: [],
    output_ids: [], theme_id: null, draft_refs: [], patents: [],
    training_slugs: [],
  };
}

function initFirestore() {
  const local = path.join(__dirname, 'service-account.json');
  admin.initializeApp(fs.existsSync(local)
    ? { credential: admin.credential.cert(require(local)) }
    : { credential: admin.credential.applicationDefault() });
  return admin.firestore();
}

/* ── run ──────────────────────────────────────────────────────── */

(async () => {
  const db = initFirestore();
  const coll = db.collection('researchFoci');
  const now = new Date().toISOString();

  // -- PRE-FLIGHT ------------------------------------------------
  if (!(await coll.doc(TFM_ID).get()).exists) throw new Error('Specialty "' + TFM_ID + '" not found.');

  const grantSnap = await coll.doc(GRANT_ID).get();
  const grantMissing = !grantSnap.exists;
  // The PI owns every card on this map; when the grant is gone, inherit the
  // author from the specialty that is definitely still there.
  const tfmSnap = await coll.doc(TFM_ID).get();
  const grant = grantMissing
    ? Object.assign({}, GRANT_CARD, {
        template_fields: { template_version: 1, answers: GRANT_ANSWERS },
        description_html: compile(TEMPLATES.grant, GRANT_ANSWERS),
        links: emptyLinks(),
      })
    : grantSnap.data();
  const author = (grantMissing ? tfmSnap.data() : grant).created_by || null;
  if (grantMissing) {
    console.log('!! The grant card ' + GRANT_ID + ' is NOT on the map.');
    console.log('!! It was there when this script was written (awarded, award');
    console.log('!! number 3062920) and has since been deleted. This run will');
    console.log('!! RECREATE it from the recorded content. If you deleted it on');
    console.log('!! purpose, stop here and say so.\n');
  }

  // The draft slug is READ BACK, never assumed: paper-builder's _freshSlug
  // appends "-2" on a collision, so slugify(title) is a guess, not a fact.
  const drafts = await db.collection('projects').where('type', '==', 'paper').get();
  const draftDoc = drafts.docs.find(d => (d.data().title || '').trim() === DRAFT_TITLE);
  const DRAFT_ID = draftDoc ? draftDoc.id : null;
  // Not finding the draft is not fatal. The card graph — specialty, concept,
  // aims, and the grant's own restore — does not depend on it; only the
  // bibliography pointer and the cited_in_drafts stamps do. So do everything
  // that can be done now and say plainly what is left; a re-run finishes it.
  if (!DRAFT_ID) {
    console.log('!! The ONR proposal is not in the paper builder yet. Import');
    console.log('!!   Data/Grants/onr-technical-proposal.paperbundle.zip');
    console.log('!! via "Import paper" on rm/pages/paper-builder.html, then run');
    console.log('!! this again — it is idempotent and will finish the wiring.');
    console.log('!! This run builds the cards and SKIPS ref_source +');
    console.log('!! cited_in_drafts.\n');
  }

  // Which library entries did the import attach to this draft?
  const items = await db.collection('items').where('type', '==', 'paper').get();
  const linked = !DRAFT_ID ? [] : items.docs.filter(d => {
    const L = (d.data().meta && d.data().meta.library) || {};
    return L.is_library_entry && (L.linked_drafts || []).includes(DRAFT_ID);
  });
  const needStamp = linked.filter(d => {
    const L = (d.data().meta && d.data().meta.library) || {};
    return !(L.cited_in_drafts || []).includes(DRAFT_ID);
  });
  const thin = linked.filter(d => {
    const L = (d.data().meta && d.data().meta.library) || {};
    return !L.doi && !L.pmid && !L.arxiv_id;
  });

  console.log(COMMIT ? '=== COMMIT ===' : '=== DRY RUN (no writes; pass --commit) ===');
  console.log('Grant        : ' + GRANT_ID + (grantMissing ? '   [MISSING — will be recreated]' : ''));
  console.log('               "' + (grant.title || '') + '"  [' + grant.status + ']');
  console.log('               links today: ' + JSON.stringify({
    specialty_ids: (grant.links || {}).specialty_ids || [],
    concept_ids: (grant.links || {}).concept_ids || [],
    draft_refs: ((grant.links || {}).draft_refs || []).map(r => r.id),
    ref_source: grant.ref_source || null,
  }));
  console.log('Draft        : ' + (DRAFT_ID || '(not imported yet — bibliography steps skipped)'));
  console.log('Library      : ' + items.size + ' papers, ' + linked.length + ' linked to this draft');
  console.log('               ' + needStamp.length + ' need a cited_in_drafts stamp');
  console.log('               ' + thin.length + ' with no DOI/PMID/arXiv id'
    + (thin.length ? ' → ' + thin.map(d => JSON.stringify((d.data().title || '').slice(0, 40))).join(', ') : ''));
  console.log('\nWould write:');
  console.log('  ' + SPECIALTY_ID + '  level=specialty  (no parents)');
  console.log('  ' + CONCEPT_ID + '  level=concept    → specialties [' + SPECIALTY_ID + ', ' + TFM_ID + ']');
  AIMS.forEach(a => console.log('  ' + a.id + '  level=aim  status=planning  → grant ' + GRANT_ID));
  if (grantMissing) console.log('  ' + GRANT_ID + '  level=grant  status=awarded  (RECREATED)');
  console.log('  patch ' + GRANT_ID + ': concept_ids += ' + CONCEPT_ID
    + (DRAFT_ID ? ', draft_refs += ' + DRAFT_ID + ', ref_source → that draft'
                : '  (no draft yet — draft_refs / ref_source deferred)'));
  console.log('  stamp meta.library.cited_in_drafts on ' + needStamp.length + ' library items');

  if (!COMMIT) { console.log('\nDry run — nothing written.'); process.exit(0); }

  const stamp = { created_by: author, created_at: now, updated_by: author, updated_at: now, schema_version: 1 };

  async function create(id, doc) {
    if ((await coll.doc(id).get()).exists) { console.log('\nskip   ' + id + ' (already exists)'); return; }
    await coll.doc(id).set(Object.assign({}, doc, stamp));
    console.log('\nwrote  ' + id);
  }

  // 1. specialty
  await create(SPECIALTY_ID, {
    level: 'specialty',
    title: 'Thermomechanics',
    abbr: 'Thermo',
    icon: '🌡️',
    color: grant.color || '',
    one_liner: 'Full-field measurement of how soft tissue expands, stiffens and damages with temperature — at and above 37 °C, where the published data stops.',
    status: 'active',
    status_source: 'manual',
    template_fields: { template_version: 1, answers: SPECIALTY_ANSWERS },
    description_html: compile(TEMPLATES.specialty, SPECIALTY_ANSWERS),
    grant_meta: null,
    ref_source: null,
    source_draft_id: null,
    links: emptyLinks(),
    media: [], member_uids: [], member_roles: {},
    order: 0, overview_blocks: [], published: false, published_at: null,
  });

  // 2. concept
  await create(CONCEPT_ID, {
    level: 'concept',
    title: 'Tissue Thermomechanics',
    abbr: 'TTM',
    icon: '💡',
    color: grant.color || '',
    one_liner: 'A spatially resolved atlas in which ECM composition and architecture predict local mechanics and thermomechanics — the “Periodic Table of Tissue Mechanical Properties”.',
    status: 'active',
    status_source: 'manual',
    template_fields: { template_version: 1, answers: CONCEPT_ANSWERS },
    description_html: compile(TEMPLATES.concept, CONCEPT_ANSWERS),
    grant_meta: null,
    ref_source: null,
    source_draft_id: null,
    links: Object.assign(emptyLinks(), { specialty_ids: [SPECIALTY_ID, TFM_ID] }),
    media: [], member_uids: [], member_roles: {},
    order: 0, overview_blocks: [], published: false, published_at: null,
  });

  // 3. aims
  for (let i = 0; i < AIMS.length; i++) {
    const a = AIMS[i];
    await create(a.id, {
      level: 'aim',
      title: a.title,
      abbr: a.abbr,
      icon: '🎯',
      color: grant.color || '',
      one_liner: a.one_liner,
      status: 'planning',
      status_source: 'manual',
      template_fields: { template_version: 1, answers: a.answers },
      description_html: compile(TEMPLATES.aim, a.answers),
      grant_meta: null,
      ref_source: null,
      source_draft_id: null,
      links: Object.assign(emptyLinks(), { grant_ids: [GRANT_ID] }),
      media: [], member_uids: [], member_roles: {},
      order: i + 1, overview_blocks: [], published: false, published_at: null,
    });
  }

  // 3b. restore the grant card itself if it is gone.
  if (grantMissing) {
    await create(GRANT_ID, Object.assign({}, GRANT_CARD, {
      template_fields: { template_version: 1, answers: GRANT_ANSWERS },
      description_html: compile(TEMPLATES.grant, GRANT_ANSWERS),
      ref_source: null,
      source_draft_id: null,
      links: emptyLinks(),
      media: [], member_uids: [], member_roles: {},
      order: 0, overview_blocks: [], published: false, published_at: null,
    }));
  }

  // 4. patch the grant. MERGE ONLY — grant_meta carries the real award
  // (number 3062920, 2026-04-01 → 2029-04-02), which is NOT the proposal's
  // stated period of performance, and the description was written by hand.
  // Re-read: step 3b may have just created it, and on a re-run the links are
  // whatever the last run (or the PI, in the browser) left behind.
  const fresh = (await coll.doc(GRANT_ID).get()).data() || {};
  const links = Object.assign(emptyLinks(), fresh.links || {});
  if (!links.concept_ids.includes(CONCEPT_ID)) links.concept_ids.push(CONCEPT_ID);
  const patch = { links: links, updated_by: author, updated_at: now };
  if (DRAFT_ID) {
    if (!links.draft_refs.some(r => r.id === DRAFT_ID)) {
      links.draft_refs.push({ id: DRAFT_ID, title: DRAFT_TITLE, kind: 'grant' });
    }
    patch.ref_source = { kind: 'draft_citations', draft_id: DRAFT_ID };
  }
  await coll.doc(GRANT_ID).set(patch, { merge: true });
  console.log('\npatched ' + GRANT_ID + ' (links'
    + (DRAFT_ID ? ' + ref_source' : '') + '; grant_meta untouched)');

  // 5. cited_in_drafts — see the header note. arrayUnion, so re-runnable.
  for (const d of needStamp) {
    await d.ref.update({
      'meta.library.cited_in_drafts': admin.firestore.FieldValue.arrayUnion(DRAFT_ID),
      updated_at: now.slice(0, 10),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
  console.log('stamped cited_in_drafts on ' + needStamp.length + ' library items');
  console.log('\nDone. Hard-refresh /rm/pages/research.html.');
  if (!DRAFT_ID) {
    console.log('Import the bundle and re-run to finish the bibliography wiring.');
  }
  process.exit(0);
})().catch(e => { console.error('\nERROR: ' + e.message); process.exit(1); });
