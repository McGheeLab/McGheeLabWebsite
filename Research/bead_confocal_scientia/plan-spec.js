/* The confocal bead ELISA as ONE Scientia note in the Source and sink project (V3.922): the content spec for
   scripts/scientia-project/build-project.js.

   node scripts/scientia-project/build-project.js Research/bead_confocal_scientia/plan-spec.js --out <records.json> [--local URL | --cloud UID [--commit]]

   Alex (2026-10-26), after the PE-bead project (p_pebeadaxr0, V3.893) was deleted from his hub: "all of the experiments
   to do should be combined into a single note into sections, there should be a simulations section of that note,
   simulations help influence the parameters we choose to design the experimental set. there is a lit review that did not
   go away, and that lit review should be influential to the project. this project should be within the source and sink
   project".

   So: a theme "Confocal bead ELISA" in the RM project Source and sink (rm-p-source-and-sink, which the hub mirrors —
   project.existing, never rewritten here), and one planning note that reads top to bottom:
     literature (the surviving review, d_lr3186c1484a, wired in) → simulations (three interactive simulators, each with
     what it decides) → the parameter set those two choose → 13 experiment sections (procedures kept in the note) →
     run order, and how results go back into the simulators.
   The review is re-linked from the deleted project to Source and sink (`reviews`). Text and numbers are the V3.893
   project's (Research/PE_bead_confocal_assay_model.md rev 2, the simulators at 2 µW, protocols.json). */
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const PROTOCOLS = require('./protocols.json');
const libPath = path.join(process.env.HOME || '', 'Documents/GitHub/LitReviews/pe-bead-confocal/build/libids.json');
const LIBRARY = JSON.parse(fs.readFileSync(fs.existsSync(libPath) ? libPath : path.join(__dirname, 'library.json'), 'utf8'));

/* the literature review note and its cards, by build-note.js's own ids */
const LR_DOC = 'd_lr3186c1484a';
const lr = k => 'c_lr' + crypto.createHash('sha1').update('pe-bead-confocal:card:' + k).digest('hex').slice(0, 10);

const SIM = '../bead_confocal_sim/';
const T = (text, o) => Object.assign({ kind: 'text', text }, o);
const FIG = (media, o) => Object.assign({ kind: 'figure', media: [].concat(media) }, o);
const COLS = [{ x: 0, w: 560 }, { x: 600, w: 560 }, { x: 1200, w: 560 }];

/* ---------------- experiments → sections of the one note ---------------- */
const tableLines = tb => {
  const head = tb.caption ? '**' + tb.caption + '**\n' : '';
  if (tb.columns.length === 2) return head + tb.rows.map(r => '• ' + (r[0] ? r[0] + ': ' : '') + r[1]).join('\n');
  return head + tb.rows.map(r => '• ' + r[0] + ' — ' + tb.columns.slice(1).map((c, i) => c + ': ' + r[i + 1]).join('; ')).join('\n');
};
const LAYER = { 1: 'Instrument', 2: 'Instrument', 3: 'Instrument', 4: 'Optics of the shell', 5: 'Optics of the shell', 6: 'Optics of the shell', 7: 'PE on this instrument', 8: 'PE on this instrument',
  9: 'Backgrounds and the assay', 10: 'Backgrounds and the assay', 11: 'Backgrounds and the assay', 12: 'Backgrounds and the assay', 13: 'The read itself' };
const EXP_SECTIONS = [];
function expSection(p) {
  const num = +(p.id.match(/pe-ax-(\d+)/) || [])[1], k = 'e' + String(num).padStart(2, '0'), short = p.title.replace(/^PE beads · Exp \d+ · /, '');
  const purpose = [p.header ? '**' + p.header + '**' : '', ...p.notes.filter(n => n.where === 'Overview').map(n => n.text), ...p.assumptions.map(a => 'Assumption: ' + a)].filter(Boolean).join('\n\n');
  const predict = p.tables.filter(t => t.where === 'Overview').map(tableLines).join('\n\n');
  const settings = p.tables.filter(t => t.where === 'Settings' || t.where === 'Plate').map(tableLines).join('\n\n');
  const scores = p.tables.filter(t => t.where === 'Analysis').map(tableLines).join('\n\n');
  const calcs = p.calculators.map(c => '**' + c.label + '** (at the defaults; live in the RM version)\n' +
    c.inputs.map(i => '• ' + i.label + ': ' + i.value).join('\n') + '\n→ ' + c.outputs.map(o => o.label + ': **' + o.value + '**').join('\n→ ')).join('\n\n');
  const steps = [];
  for (const s of p.procedure) {
    if (s.step) steps.push(s.step);
    else if (s.heading) steps.push('▸ ' + s.heading);
    else if (s.note && steps.length) steps[steps.length - 1] += ' Note: ' + s.note;
  }
  let n = 0;
  const analysis = p.analysis.map(a => a.heading ? '**' + a.heading + '**' : a.note ? 'Note: ' + a.note : (++n) + '. ' + a.step).join('\n');
  const items = [
    T('**' + p.summary + '**' + (purpose ? '\n\n' + purpose : '') + (predict ? '\n\n' + predict : ''), { key: k + '_purpose', label: 'Purpose and prediction · ' + LAYER[num], col: 0 }),
    p.materials.length ? T(p.materials.map(m => '• ' + m).join('\n'), { key: k + '_mat', label: 'Materials', col: 0 }) : null,
    p.cautions.length ? T(p.cautions.map(c => '• ' + c.text).join('\n'), { key: k + '_caution', label: 'Before you start', col: 0 }) : null,
    { kind: 'protocol', key: k + '_run', label: 'Exp ' + String(num).padStart(2, '0') + ' · ' + short, steps, keep: true, col: 1 },
    settings ? T(settings, { key: k + '_settings', label: 'Settings for this run', col: 2 }) : null,
    calcs ? T(calcs, { key: k + '_calc', label: 'Numbers', col: 2 }) : null,
    p.timeline ? T('**' + (p.timeline.title || 'Timeline') + '**\n' + p.timeline.marks.map(m => '• ' + m.at + ' — ' + m.label + (m.sub ? ' (' + m.sub + ')' : '') + (m.included ? '' : ' [optional]')).join('\n'), { key: k + '_time', label: 'Timeline', col: 2 }) : null,
    analysis ? T(analysis + (scores ? '\n\n' + scores : ''), { key: k + '_analysis', label: 'Analysis', col: 2 }) : null,
    p.decision.length ? T(p.decision.join('\n\n'), { key: k + '_decision', label: 'What the result decides', col: 2 }) : null,
  ].filter(Boolean);
  if (p.builder && p.plate) items.push(plateItem(p, k), FIG('setup_plate', { key: k + '_platefig', label: 'Plate map and wash timing', span: [1, 2] }));
  return { name: 'Exp ' + String(num).padStart(2, '0') + ' · ' + short, color: '#2a78d6', items };
}
function plateItem(p, k) {
  const COL = { 1: '#4CC9F0', 2: '#4361EE', 5: '#7B2CBF' }, ROW = { '1a': 'A', '1b': 'B', '2a': 'C', '2b': 'D', '5a': 'E', '5b': 'F' };
  const fmtC = pm => pm === 0 ? 'blank' : pm >= 1000 ? +(pm / 1000).toPrecision(2) + ' nM' : +pm.toPrecision(2) + ' pM';
  const wells = {};
  for (const r of p.builder.rows) wells[ROW[r.d0x + r.rep] + (r.step + 1)] = { color: COL[r.d0x], info: fmtC(r.conc_pm) + ' · detection antibody ' + r.d0_nm + ' nM' };
  for (const R of 'GH') for (let c = 1; c <= 12; c++) wells[R + c] = { color: '#ADB5BD', info: 'spare: buffer, NSB or reference' };
  return { kind: 'plate', key: k + '_plate', label: 'Standard-curve plate', col: 0, w: 560, wells, legend: { '#4CC9F0': 'detection antibody 1 × K₂', '#4361EE': 'detection antibody 2 × K₂', '#7B2CBF': 'detection antibody 5 × K₂', '#ADB5BD': 'spare / reference' } };
}
for (const p of PROTOCOLS) EXP_SECTIONS.push(expSection(p));

/* ---------------- the spec ---------------- */
module.exports = {
  slug: 'confocal-bead-elisa', idTag: 'cbe', createdAt: '2026-10-26T12:00:00-07:00',
  device: { id: 'dv_cbe_plan', name: 'Confocal bead ELISA builder' },
  project: { id: 'rm-p-source-and-sink', name: 'Source and sink', existing: true },
  themes: [
    { id: 't_cbe_assay', name: 'Confocal bead ELISA', question: 'How should the AX R read PE on a capture bead so that one number per bead follows the cytokine concentration, and which settings and assay conditions do the simulations and the literature choose for the experiments?' },
  ],
  aims: [
    { id: 'a_cbe_valid', themeId: 't_cbe_assay', statement: 'A validated bead read: every parameter of the experimental set measured on our AX R and our beads', milestones: [
      { label: 'Exp 01 · power at the sample', weight: 0.06 }, { label: 'Exp 02 · photon transfer', weight: 0.06 }, { label: 'Exp 03 · flat field', weight: 0.04 },
      { label: 'Exp 04 · PSF, plane response, axial scaling', weight: 0.08 }, { label: 'Exp 05 · bead z-series in four modes', weight: 0.14 }, { label: 'Exp 06 · sampling and field', weight: 0.04 },
      { label: 'Exp 07 · bleaching, saturation, dark state', weight: 0.10 }, { label: 'Exp 08 · gain ladder', weight: 0.04 }, { label: 'Exp 09 · backgrounds and NSB', weight: 0.10 },
      { label: 'Exp 10 · PE per bead', weight: 0.08 }, { label: 'Exp 11 · rate constants', weight: 0.10 }, { label: 'Exp 12 · standard curve and hook', weight: 0.10 },
      { label: 'Exp 13 · mode head-to-head', weight: 0.06 }] },
  ],
  library: LIBRARY,
  media: {
    fig1: { file: SIM + 'figures/fig1_binding.png', name: 'Binding: coverage, hook, wash, transport.png' },
    fig2: { file: SIM + 'figures/fig2_gallery.png', name: 'Gallery: one bead in every mode.png' },
    fig3: { file: SIM + 'figures/fig3_metrics_vs_z0.png', name: 'Metrics against focus.png' },
    fig4: { file: SIM + 'figures/fig4_sampling.png', name: 'Pixels per bead and sub-pixel position.png' },
    fig5: { file: SIM + 'figures/fig5_photon_budget.png', name: 'Photon budget and bleaching.png' },
    fig9: { file: SIM + 'figures/fig9_backgrounds.png', name: 'Backgrounds and LOD.png' },
    setup_assay: { file: SIM + 'figures/setup_assay.png', name: 'Set-up: one-step sandwich.png' },
    setup_section: { file: SIM + 'figures/setup_section.png', name: 'Set-up: optical section through a shell.png' },
    setup_axr: { file: SIM + 'figures/setup_axr.png', name: 'Set-up: the AX R for PE beads.png' },
    setup_plate: { file: SIM + 'figures/setup_plate.png', name: 'Set-up: standard-curve plate and timing.png' },
    setup_validation: { file: SIM + 'figures/setup_validation.png', name: 'Validation map.png' },
    sim_binding: { file: SIM + 'interactive/pe-bead-binding.html', name: 'pe-bead-binding.html' },
    sim_confocal: { file: SIM + 'interactive/pe-bead-confocal.html', name: 'pe-bead-confocal.html' },
    sim_strategy: { file: SIM + 'interactive/pe-bead-strategy.html', name: 'pe-bead-strategy.html' },
  },
  /* the surviving review: from the deleted project to Source and sink */
  reviews: [{ docId: LR_DOC, addProjectIds: ['rm-p-source-and-sink'], removeProjectIds: ['p_pebeadaxr0'] }],
  notes: [{
    key: 'plan', id: 'd_cbe0plan', type: 'planning', themeId: 't_cbe_assay', title: 'Confocal bead ELISA: simulations and experimental plan', tags: ['confocal bead ELISA', 'PE beads', 'AX R', 'plan'],
    synthesis: 'One plan for reading cytokine on capture beads with the AX R. The literature review and three simulators choose the parameter set; 13 experiments, one section each, measure every parameter on our instrument and beads. Nothing has been measured yet.',
    columns: COLS,
    sections: [
      /* ---------------------------------------------------------------- start here */
      { name: 'Start here', color: '#8D99AE', items: [
        T('**What this note is.** The whole confocal bead ELISA in one place, read from the top down:\n' +
          '1. **What the literature sets**: the review’s verdicts, turned into design constraints.\n' +
          '2. **Simulations**: binding, the confocal image and the plate read. Each one ends in what it decides.\n' +
          '3. **The parameter set**: every setting and assay condition the experiments use, with where it came from and which experiment checks it.\n' +
          '4. **Experiments 01–13**: one section each. The procedure is a protocol kept in this note, so it can be run here.\n' +
          '5. **Run order and data back**: what to do first, and how results go back into the simulators and the parameter set.\n\n' +
          '**In Source and sink.** Capture beads read the cytokine a source puts into its surroundings (in the paper, a PC-3 spheroid in the microgel bath with BD CBA Flex Set beads and PE detection reagents). Every concentration we report rests on this bead read. Here it is validated on the AX R in plate wells, where each condition can be controlled.\n\n' +
          '**Where it stands (26 Oct 2026).** Nothing has been measured on our beads yet. It rebuilds the PE-bead project of 24 Oct (deleted from the hub on 26 Oct) as this one note; the simulators, figures and procedures are unchanged.', { key: 'what', label: 'Read me first', col: 0 }),
        T('Which AX R settings and assay conditions give a per-bead number that follows the cytokine, and how far can we trust it?\nThe simulations propose the answer, the literature corrects it, and the experiments measure it.', { key: 'q', label: 'The question', col: 1, struct: 'question' }),
        T('What are the capture beads made of, and what is their refractive index?\nPolystyrene, PMMA, silica or hydrogel sets how much the bead bends light, and so where to focus and whether F stays flat with focus. Ask BD for the Flex Set bead material; Exp 05 measures it either way.', { key: 'q1', label: 'Open question', col: 1, struct: 'question' }),
        T('Which 20x objective is on the AX R: NA 0.75 or 0.80?\nRead it off the barrel. The section and the collection differ by ≈15 %.', { key: 'q2', label: 'Open question', col: 1, struct: 'question' }),
        { kind: 'noteref', key: 'review', docId: LR_DOC, title: 'PE bead assay model: lit review', col: 2, w: 560 },
        FIG('setup_assay', { key: 'assay', label: 'The assay', col: 2, caption: 'A one-step sandwich: two routes put PE on the bead, and only PE on the surface is measured. Rates: capture k₁/k₋₁, labelling on the bead k₂/k₋₂, complex captured k₃/k₋₃, complex in solution k₄/k₋₄.' }),
      ] },

      /* ---------------------------------------------------------------- 1 · literature */
      { name: '1 · What the literature sets', color: '#eb6834', items: [
        T('The review checked every assumption the model rests on against 27 papers. Its verdicts: binding holds, but the wash must be read as an effective rate (A); PE’s constants hold, but it is not a two-level dye (B); one calibrated confocal plane is quantitative (C); and the index-matched shell is the exception, not the rule (D). Each card below turns one verdict into a constraint on the design and says what it changes; its links at the foot open the review’s own findings. The parameter set (section 3) marks each value the review set with “review A–D”.', { key: 'l_intro', label: 'How the review steers the plan', col: 'full', w: 1760 }),
        T('**The wash is an effective rate.** After the wash, PE leaving one bond can rebind, so the loss Λ is slower than k₋₂ + k₋₃, about $k_{-2} + k_{-3}/(1+Da_3)$, and its tail need not be exponential [[cite:goldstein1999]].\n→ Fit Exp 11 with rebinding and run two capture densities. The wash plan (one wash or column-staggered) is chosen from the measured Λ, not the intrinsic rates.', { key: 'l_wash', label: 'A · binding → the wash plan', col: 0 }),
        T('**Bead number is a calibration parameter.** Beads × capture sites set the capture clock, and a 1 h incubation is far from equilibrium (≈35 % captured at 10⁴ beads in 50 µL) [[cite:rissin2010]] [[cite:chang2012]].\n→ Count the beads (≤ 5 % CV) and fix beads per volume in every well.', { key: 'l_clock', label: 'A · binding → beads per well', col: 0 }),
        T('**Guard the hook.** In a one-step assay free analyte competes with the labelled complex; capacity and the detection-antibody level move the hook [[cite:fernandowilson1992]] [[cite:saateh2026]].\n→ Keep the 1× / 10× dilution check (Exp 12); standards must span the hook.', { key: 'l_hook', label: 'A · binding → standards and dilutions', col: 0 }),
        T('**2 µW is an upper bound, not a target.** R-PE goes dark reversibly within milliseconds and sublinear at higher power, which a two-level model misses; the beam returns to a molecule ~4 ms later, inside the dark-state time [[cite:gaigalas2006]] [[cite:doornbos1997]].\n→ Cap the power at 1–2 µW until Exp 07 measures linearity and recovery at the real dwell, line period and frame interval.', { key: 'l_pe', label: 'B · PE → the power cap', col: 1 }),
        T('**Brightness on a bead may differ from solution.** On cells the fitted PE extinction was ~25 % of the solution value; on microspheres absorption shifts [[cite:doornbos1997]] [[cite:gaigalas2005]].\n→ Absolute PE per bead needs an on-bead cross-check (Exp 07g, Exp 10).', { key: 'l_bright', label: 'B · PE → absolute calibration', col: 1 }),
        T('**Calibrate the instrument, every session.** Power in µW at the sample, never % laser (10–25 % drift over 3 h); a 2–3 h warm-up; no clipped pixels and a photon-transfer line; flat-field (≥ 10 % fall-off corner to centre); axial scale from a dye-filled chamber of known height, not bead peaks [[cite:jonkman2020]] [[cite:quarep2021]] [[cite:waters2009]] [[cite:murray2007]] [[cite:besseling2015]].\n→ Exp 01–04 come first and short versions run every session.', { key: 'l_cal', label: 'C · imaging → the calibrations', col: 1 }),
        T('**Focus between beads is the big noise source.** With many beads, focus scatter dominated one-plane reads [[cite:murray2007]].\n→ Image at the measured stationary point of F(z₀), where focus scatter costs least, and judge focus in transmitted light.', { key: 'l_focus', label: 'C · imaging → the focus plane', col: 1 }),
        T('**The bead bends light.** A polystyrene particle in water loses much of its far-hemisphere signal to reflection and refraction; an index-matched hydrogel particle does not [[cite:vorselen2020]] [[cite:darafsheh2021]]. Shell beads image as stretched, possibly asymmetric rings [[cite:bratton2015]].\n→ Settle the bead material first; Exp 05 measures F against focus and its symmetry, with ring-stained FocalCheck beads beside ours as a known shell.', { key: 'l_optics', label: 'D · the bead → Exp 05 first', col: 2 }),
        T('**Absolute numbers go through MESF.** Equivalent-fluorophore standards and QuantiBRITE PE (1:1 PE:antibody) put PE per bead on an absolute scale, with environment caveats [[cite:wang2002]] [[cite:gaigalas2005]] [[cite:pannu2001]].\n→ Exp 10 calibrates with a solution-PE reference and the measured section, cross-checked by flow cytometry; the paper anchors the same chain on Quantum R-PE MESF beads.', { key: 'l_mesf', label: 'D · the bead → PE per bead', col: 2 }),
        T('**Still open in the literature:** our antibody pair’s rates and sites (k_on, k₋₁, k₋₂, active capture sites, non-specific binding), and how a PE molecule ~10 nm from the bead surface changes the collected fraction.\n→ Exp 10 and 11 measure the pair; Exp 05’s controls (the same PE-antibody on index-matched and polystyrene beads) test the surface.', { key: 'l_open', label: 'Gaps the experiments fill', col: 2 }),
      ] },

      /* ---------------------------------------------------------------- 2 · simulations */
      { name: '2a · Simulation: binding on the bead', color: '#6250d6', items: [
        { kind: 'html', key: 's_bind', media: 'sim_binding', label: 'Binding simulator', col: 'full', w: 1760, h: 900 },
        T('**What it models.** A one-step sandwich on the capture bead with mass action, finite sites, depletion and transport to a sphere [[cite:bergpurcell1977]] [[cite:goldsteindembo1995]]. PE coverage factors into capture × labelling, $\\theta_{PE} = \\theta_{cap}\\cdot g$; the detection-antibody level sets the ceiling, $N_{max} = S_T D_T/(K_2 + D_T)$, and the hook, which starts near $A_T \\approx \\max(S_T + K_1,\\ D_T + K_2)$. After the wash PE leaves at about $k_{-2} + k_{-3}$.\n\n**Reference case:** 10⁶ capture sites per bead, 10⁴ beads in 50 µL, K₁ = 20 pM, K₂ = 2.15 nM, D_T = 2 nM → ≈500 PE per bead at 1 pM after 1 h; Damköhler 0.28–0.38. Tabs: dose–response with the hook, the time course through the wash, design sweeps of D_T and bead number. A port of `binding.py`, within 0.06 % of it.', { key: 's_bind_what', label: 'What the simulation models', col: 0 }),
        T('Assay conditions chosen by the binding simulation\n• **Detection antibody D_T = 1–2 × K₂** (≈2–4 nM): enough ceiling, the hook above the sample range, the least no-wash and non-specific background. 2–5 × K₂ only if Exp 09 finds non-specific binding negligible.\n• **10⁴ beads in 50 µL, counted:** bead number sets the capture clock and, where beads deplete the analyte, PE per bead ∝ A_T·V/n_b.\n• **1 h incubation, mixed** (3 h roughly doubles the signal).\n• **Standards:** ≥ 8 spanning the hook at three D_T levels (1, 2, 5 × K₂); unknowns at 1× and 10×.\n• **Wash plan from Λ:** ≲ 2 × 10⁻⁴ s⁻¹ one wash; 2 × 10⁻⁴–10⁻³ column-staggered, each column imaged 5 ± 0.5 min after its wash; ≳ 10⁻³ read without a wash.', { key: 's_bind_sets', label: 'What it decides', col: 1, struct: 'decision' }),
        FIG('fig1', { key: 's_bind_fig', label: 'Binding in the reference case', col: 2, caption: '(a) Coverage against analyte at three detection-antibody levels. (b) The one-step hook. (c) PE after the wash at three detection off-rates. (d) Transport switched off.' }),
      ] },
      { name: '2b · Simulation: the confocal image of a PE shell', color: '#6250d6', items: [
        { kind: 'html', key: 's_conf', media: 'sim_confocal', label: 'Confocal simulator', col: 'full', w: 1760, h: 900 },
        T('**What it models.** PE sits on the bead surface, a shell, and one pinhole-set plane images it as a ring. The integrated intensity $F = 2\\pi R\\,\\sigma_s\\int w(z-z_0)\\,dz$ follows the PE count and barely moves with focus while the section is thinner than the bead (Archimedes’ hat-box theorem); the rim peak does not. Photons: ≈0.18 photoelectrons per PE per frame at 2 µW, 2 µs, 0.43 µm pixels; bleaching 0.05 % per frame. Every AX R setting is a control: objective, pinhole, laser, gain, PE density, bleaching, pixels per bead, dwell, focal offset, field position, bead material (ray-trace estimate), free PE, autofluorescence. Checked against `optics.py` within 0.6 %.', { key: 's_conf_what', label: 'What the simulation models', col: 0 }),
        T('Imaging settings chosen by the confocal simulation\n• **Metric: integrated F per bead**, background-subtracted; within 2 % of its best over ±1.2 µm of focus at 20x, 1 AU, while the rim peak loses 12–18 % at 1 µm. Ring mean and rim peak only for QC.\n• **20x at 1 AU** (section 2.3–2.6 µm, thinner than the bead → a flat top; ≈1.5× more photons per bleaching dose than 10x; ≈3× less free-PE background).\n• **1–2 µW at the sample** (F 5 % sublinear only at ≈5–6 µW in the model; the review caps it lower).\n• **Galvano 2 µs, 0.43 µm pixels** (2048², zoom 1; 12–20 px per bead are enough for F).\n• **One plane, one frame per field**, at the measured flat point of F.\n• **One HV per plate**, the brightest standard’s rim at 70–80 % of full scale; flat-field every session.', { key: 's_conf_sets', label: 'What it decides', col: 1, struct: 'decision' }),
        FIG(['fig3', 'fig5'], { key: 's_conf_fig', label: 'Focus and the photon budget', col: 2, rows: 2, cols: 1, captions: ['Integrated F, ring mean, rim peak and ring radius against focal offset, 20x and 10x at 1, 2 and 4 AU.', 'SNR against dwell and power, PE lost per frame, SNR per % bleached, linearity at 2 µW.'] }),
        FIG(['fig2', 'fig4'], { key: 's_conf_fig2', label: 'Modes and sampling', span: [0, 1], cols: 2, captions: ['One bead in every mode: equator, 2 µm and 3.5 µm above it.', 'Pixels per bead and sub-pixel position: F is stable from 12 px per bead.'] }),
        FIG('setup_section', { key: 's_conf_sec', label: 'How one plane sees a shell', col: 2 }),
      ] },
      { name: '2c · Simulation: reading a plate', color: '#6250d6', items: [
        { kind: 'html', key: 's_strat', media: 'sim_strategy', label: 'Strategy explorer', col: 'full', w: 1760, h: 900 },
        T('**What it models.** The plate as it is read: settling, the time per well and per plate against the post-wash rate, the photon budget and per-well precision, the LOD with non-specific binding, the four read modes side by side, and saturation and bleaching against power. **Recommended** loads the default strategy.\n\n**Key numbers.** One field per well takes 12–15 s (2 µs dwell); a 96-well plate 19–24 min. At Λ = 8.6 × 10⁻⁴ s⁻¹ one wash spreads the PE loss over 63–71 % of the plate; staggering by column holds it to ±4–5 %. Per-bead LOD ≈65 PE washed; 91, 214 and 649 PE at 0.1, 1 and 10 nM free PE-antibody. With non-specific binding, $\\mathrm{LOD}_{well}\\approx3\\sqrt{SD_{bead}^2/n+(c_{well}N_{SD})^2}$.', { key: 's_strat_what', label: 'What the simulation models', col: 0 }),
        T('Plate design chosen by the strategy simulation\n• **≥ 100 beads per well, ≥ 2 wells per condition**, the median F per well; beads found in transmitted light, never in PE.\n• **Settle with a 1 min plate spin at 100–300 g** (gravity takes ≈15 min through a 1.5 mm fill).\n• **A fixed, logged delay from wash to image**; column-staggered washes if Λ is 2 × 10⁻⁴–10⁻³ s⁻¹.\n• **Non-specific binding, not optics, sets the LOD**: 1,000 PE per bead at 10 % between wells costs ≈300 PE per bead (10–50× the optical limit). Exp 09 sets D_T and the wells per condition.\n• **Read mode:** 20x at 1 AU by default; 10x at a large pinhole only if Exp 13 shows it matches per minute.', { key: 's_strat_sets', label: 'What it decides', col: 1, struct: 'decision' }),
        FIG('fig9', { key: 's_strat_fig', label: 'Backgrounds and the LOD', col: 2, caption: 'Per-bead LOD (3 SD of a blank bead, integrated F, 2 µW, 2 µs) against free PE-antibody and bead autofluorescence.' }),
        FIG('setup_axr', { key: 's_strat_axr', label: 'The AX R set-up', col: 2 }),
      ] },

      /* ---------------------------------------------------------------- 3 · parameter set */
      { name: '3 · The parameter set for the experiments', color: '#1baf7a', items: [
        T('Every experiment below uses these values unless it varies one on purpose. Each line says where the value came from (**sim** = section 2, **review** = section 1) and which experiment measures it. A result that moves a value is written here, then the simulators are rerun (see Run order).', { key: 'p_intro', label: 'How to use this', col: 'full', w: 1760 }),
        T('**Instrument and optics**\n• Objective: 20x/0.75–0.80 (sim 2b) · Exp 04, 05, 13\n• Pinhole: 1 AU (sim 2b; review: the standard trade-off) · Exp 04\n• Laser: 561 nm, 1–2 µW measured at the sample (sim 2b; review B caps it) · Exp 01, 07\n• Scan: galvano 2 µs, 2048² zoom 1, 0.43 µm pixels, 12–20 px per bead (sim 2b) · Exp 06\n• Focus: one plane at the measured flat point of F, held by Perfect Focus; judged in transmitted light (sim 2b; review C, D) · Exp 05\n• Flat field per objective and scan format, each session (review C) · Exp 03\n• Warm-up 2–3 h; reference well at the start and end (review C) · every session', { key: 'pOptics', label: 'Parameters', col: 0 }),
        T('**Detector and read**\n• Detector: GaAsP (NSPARC in the paper), emission ≈575–650 nm (sim 2b) · Exp 02\n• HV: one per plate, brightest standard’s rim at 70–80 % of full scale; never clip (sim 2b; review C) · Exp 02, 08\n• Metric: integrated F per bead, background ring subtracted, normalised by R; ring mean and rim peak only for QC (sim 2b) · Exp 05, 06\n• Frames: one per field (bleaching ≈0.05 % per frame at 2 µW) (sim 2b) · Exp 07\n• Beads: ≥ 100 per well, median F, ≥ 2 wells per condition; segmentation in transmitted light (sim 2c) · Exp 13\n• Calibration to PE per bead: solution-PE reference with the measured section, cross-checked by flow cytometry on QuantiBRITE / MESF (review D) · Exp 10\n• Read mode: 20x 1 AU by default (sim 2c) · Exp 13', { key: 'pRead', label: 'Parameters', col: 1 }),
        T('**Assay and plate**\n• Beads: 10⁴ in 50 µL, counted to ≤ 5 % CV (sim 2a; review A) · Exp 11\n• Detection antibody: 1–2 × K₂ (≈2–4 nM) (sim 2a) · Exp 09, 12\n• Incubation: 1 h, mixed, fixed temperature (sim 2a) · Exp 11\n• Settling: 1 min plate spin at 100–300 g (sim 2c) · Exp 11\n• Wash: chosen from the measured Λ, with a fixed logged delay to imaging (sim 2a, 2c; review A) · Exp 11\n• Standards: ≥ 8 spanning the hook, three D_T levels, blanks; unknowns at 1× and 10× (sim 2a; review A) · Exp 12\n• Controls: capture-only beads, beads + PE-antibody without analyte, buffer + PE-antibody (sim 2c) · Exp 09\n• Plate: glass-bottom 96-well, #1.5H', { key: 'pAssay', label: 'Parameters', col: 2 }),
        FIG('setup_validation', { key: 'p_map', label: 'Which experiment pins which part', span: [0, 1], caption: 'Filled dot: the experiment that measures it. Ring: one that checks it. Right: the protocol choice the result sets.' }),
        T('**What would change the parameter set**\n• The bead bends light (Exp 05): focus at the measured flat point, not the equator; calibrate the bead-optics factor before reporting absolute PE.\n• PE leaves fast after the wash (Exp 11): stagger the wash by column, or read without a wash.\n• Non-specific binding is high (Exp 09): D_T toward 1 × K₂, more wells per condition, report the per-well LOD.\n• PE goes sublinear early (Exp 07): lower the power; lengthen the dwell or average frames at the same dose.\n• 10x at a large pinhole matches the 20x per minute (Exp 13): switch the routine read to 10x for its fourfold field.\n• The hook sits within 10× of the sample range (Exp 12): move to a two-step format.', { key: 'p_change', label: 'Triggers', col: 2 }),
      ] },

      /* ---------------------------------------------------------------- 4 · experiments */
      ...EXP_SECTIONS,

      /* ---------------------------------------------------------------- 5 · run order */
      { name: 'Run order and data back', color: '#eda100', items: [
        T('**If there is only one day:**\n1. Exp 01: power at the sample\n2. Exp 02: photon transfer\n3. Exp 05: one bead z-series at 20x and 10x, 1 AU, with transmitted light (answers the bead-optics question)\n4. Exp 04: the glass-to-solution edge scan (answers the section and its tails)\n5. Exp 11: a post-wash time course at 0, 5, 15, 30 and 60 min (answers Λ and so the wash plan)\n\n**The full plan** (6–8 sessions), bottom up because each layer leans on the one below: instrument (Exp 01–03, half a day; short versions every session) → optics of the shell (Exp 04–06) → PE on this instrument (Exp 07–08) → backgrounds and calibration (Exp 09–10) → kinetics and the standard curve (Exp 11–12, two to three sessions) → the head-to-head (Exp 13).', { key: 'order', label: 'Run order', col: 0 }),
        T('**Ground rules for every session:** warm up 2–3 h; measure µW at the sample; transmitted light with every PE frame; never focus in PE; one HV and offset per session; no saturated pixels; raw .nd2 outside the repo; log temperature and time since the wash.\n\n**With every acquisition, record:** objective and NA; pinhole (AU, µm); laser line and µW at the sample; HV, offset, gain, bit depth; dwell, pixel size, frame size, averaging; emission band; Perfect Focus offset; time since the wash; plate and well.', { key: 'rules', label: 'Every session', col: 1 }),
        T('**Results go back into the simulations.** Hand back one CSV per plate (plate, well, field, bead id, x, y, radius from transmitted light, F in DN, background per pixel, ring mean, rim peak, focus flag, time since wash) and the session log. The fits update `Research/bead_confocal_sim/params.py`: the section w(z) and its tails, the bead-optics factor, φ_d and the saturation threshold, the detector conversion, Λ and the binding constants, the non-specific background. Then the simulators are regenerated, section 3 is updated where a value moved, and the milestone of the experiment is checked off on this theme’s aim.\n\nRM protocol imports with live calculators for every experiment: `Research/bead_confocal_protocols/`.', { key: 'back', label: 'Data back', col: 2 }),
      ] },
    ],
  }],
  wires: [],
};

/* the review's cards → the constraints they set (wires into this note from the review) */
const W = module.exports.wires, from = k => '#' + lr(k);
[['fA2', 'l_wash'], ['vA', 'l_wash'], ['fA3', 'l_clock'], ['fA4', 'l_hook'], ['vB', 'l_pe'], ['fB3', 'l_pe'], ['fB4', 'l_bright'], ['vC', 'l_cal'],
  ['fC2', 'l_cal'], ['fC3', 'l_cal'], ['fC4', 'l_cal'], ['fC6', 'l_cal'], ['fC5', 'l_focus'], ['vD', 'l_optics'], ['fD2', 'l_optics'], ['fD1', 'l_optics'],
  ['fD4', 'l_mesf'], ['open', 'l_open'], ['qA', 'l_open'], ['qD', 'l_open']].forEach(([c, to]) => W.push({ from: from(c), to: 'plan:' + to, rel: 'c:informs' }));
/* No wires inside this note: Scientia loops a vertical wire out to the side by its span, and the parameter set sits
   thousands of pixels from the cards that set it and the experiments that test it. Each parameter line names its source
   (sim 2a–2c, review A–D) and its experiment instead. */
