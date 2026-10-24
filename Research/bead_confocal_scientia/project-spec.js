/* The PE-bead assay as a Scientia project: the content spec for scripts/scientia-project/build-project.js.

   node scripts/scientia-project/build-project.js Research/bead_confocal_scientia/project-spec.js --out <records.json> [--local URL | --cloud UID [--commit]]

   Notes: overview · binding model · image model · simulation results · measurement strategy · two set-up notes ·
   validation approach · 13 protocol notes (one per experiment, from protocols.json). The literature review is its own
   note, built by scripts/litreview/build-note.js and linked to this project (review.projectIds). Text follows the
   report (Research/PE_bead_confocal_assay_model.md, revision 2) and the simulators; numbers are the report's or the
   regenerated simulator's (2 µW). */
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const PROTOCOLS = require('./protocols.json');
const libPath = path.join(process.env.HOME || '', 'Documents/GitHub/LitReviews/pe-bead-confocal/build/libids.json');
const LIBRARY = JSON.parse(fs.readFileSync(fs.existsSync(libPath) ? libPath : path.join(__dirname, 'library.json'), 'utf8'));

/* the literature review note (pe-bead-confocal) and its finding cards, by build-note.js's own ids */
const LR_DOC = 'd_lr3186c1484a';
const lr = k => 'c_lr' + crypto.createHash('sha1').update('pe-bead-confocal:card:' + k).digest('hex').slice(0, 10);

const SIM = '../bead_confocal_sim/';
const T = (text, o) => Object.assign({ kind: 'text', text }, o);
const FIG = (media, o) => Object.assign({ kind: 'figure', media: [].concat(media) }, o);

/* ---------------- experiments → protocol notes ---------------- */
const EXP = {};   // number → note key
const tableLines = tb => {
  const head = tb.caption ? '**' + tb.caption + '**\n' : '';
  if (tb.columns.length === 2) return head + tb.rows.map(r => '• ' + (r[0] ? r[0] + ': ' : '') + r[1]).join('\n');
  return head + tb.rows.map(r => '• ' + r[0] + ' — ' + tb.columns.slice(1).map((c, i) => c + ': ' + r[i + 1]).join('; ')).join('\n');
};
function expNote(p) {
  const num = (p.id.match(/pe-ax-(\d+)/) || [])[1], key = 'exp' + num, short = p.title.replace(/^PE beads · /, '');
  EXP[+num] = key;
  const purpose = [p.header ? '**' + p.header + '**' : '', ...p.notes.filter(n => n.where === 'Overview').map(n => n.text), ...p.assumptions.map(a => 'Assumption: ' + a)].filter(Boolean).join('\n\n');
  const predict = p.tables.filter(t => t.where === 'Overview').map(tableLines).join('\n\n');
  const settings = p.tables.filter(t => t.where !== 'Overview').map(tableLines).join('\n\n');
  const calcs = p.calculators.map(c => '**' + c.label + '** (values at the defaults; live in the RM version)\n' +
    c.inputs.map(i => '• ' + i.label + ': ' + i.value).join('\n') + '\n→ ' + c.outputs.map(o => o.label + ': **' + o.value + '**').join('\n→ ')).join('\n\n');
  const calcNotes = p.notes.filter(n => n.where === 'Calculator').map(n => n.text).join('\n');
  const steps = [];
  for (const s of p.procedure) {
    if (s.step) steps.push(s.step);
    else if (s.heading) steps.push('▸ ' + s.heading);
    else if (s.note && steps.length) steps[steps.length - 1] += ' Note: ' + s.note;
  }
  let n = 0;
  const analysis = p.analysis.map(a => a.heading ? '**' + a.heading + '**' : a.note ? 'Note: ' + a.note : (++n) + '. ' + a.step).join('\n');
  const cautions = p.cautions.map(c => c.text);
  const items0 = [
    T(purpose + (predict ? '\n\n' + predict : ''), { key: 'purpose', label: 'Purpose and prediction', col: 0 }),
    p.materials.length ? T(p.materials.map(m => '• ' + m).join('\n'), { key: 'materials', label: 'Materials', col: 0 }) : null,
    ...cautions.slice(0, 1).map((c, i) => T(c, { key: 'caution' + i, label: 'Before you start', col: 0 })),
  ];
  const items1 = [
    { kind: 'protocol', key: 'run', label: short, steps, col: 1 },
    ...cautions.slice(1).map((c, i) => T(c, { key: 'caution' + (i + 1), label: 'Caution', col: 1 })),
  ];
  const items2 = [
    settings ? T(settings, { key: 'settings', label: 'Settings', col: 2 }) : null,
    calcs ? T(calcs + (calcNotes ? '\n\n' + calcNotes : ''), { key: 'calc', label: 'Calculator', col: 2 }) : null,
    p.timeline ? T('**' + (p.timeline.title || 'Timeline') + '**\n' + p.timeline.marks.map(m => '• ' + m.at + ' — ' + m.label + (m.sub ? ' (' + m.sub + ')' : '') + (m.included ? '' : ' [optional]')).join('\n'), { key: 'timeline', label: 'Timeline', col: 2 }) : null,
    analysis ? T(analysis, { key: 'analysis', label: 'Analysis', col: 2 }) : null,
    p.decision.length ? T(p.decision.join('\n\n'), { key: 'decision', label: 'Decision', col: 2, struct: 'decision' }) : null,
    p.record.length ? T(p.record.map(tableLines).join('\n\n') + '\n\nRM version with live calculators: Research/bead_confocal_protocols/' + p.file, { key: 'record', label: 'Record', col: 2 }) : null,
  ];
  const sections = [{ name: 'Experiment ' + num, color: '#2a78d6', items: [...items0, ...items1, ...items2].filter(Boolean) }];
  if (p.builder && p.plate) sections.push({ name: 'Plate', color: '#6250d6', items: [plateItem(p), FIG('setup_plate', { key: 'platefig', label: 'Plate map and wash timing', col: 'full', w: 1100 })] });
  return { key, type: 'protocol', title: short, synthesis: p.summary, tags: ['pe-bead', 'experiment ' + num], header: { version: 'v1 · ' + p.id + ' (RM import, 2026-10-24)' }, columns: [{ x: 0, w: 520 }, { x: 560, w: 520 }, { x: 1120, w: 520 }], sections };
}
function plateItem(p) {
  const COL = { 1: '#4CC9F0', 2: '#4361EE', 5: '#7B2CBF' }, ROW = { '1a': 'A', '1b': 'B', '2a': 'C', '2b': 'D', '5a': 'E', '5b': 'F' };
  const fmtC = pm => pm === 0 ? 'blank' : pm >= 1000 ? +(pm / 1000).toPrecision(2) + ' nM' : +pm.toPrecision(2) + ' pM';
  const wells = {};
  for (const r of p.builder.rows) wells[ROW[r.d0x + r.rep] + (r.step + 1)] = { color: COL[r.d0x], info: fmtC(r.conc_pm) + ' · detection antibody ' + r.d0_nm + ' nM' };
  for (const R of 'GH') for (let c = 1; c <= 12; c++) wells[R + c] = { color: '#ADB5BD', info: 'spare: buffer, NSB or reference' };
  return { kind: 'plate', key: 'plate', label: 'Exp 12 standard-curve plate', col: 0, w: 640, wells, legend: { '#4CC9F0': 'detection antibody 1 × K₂', '#4361EE': 'detection antibody 2 × K₂', '#7B2CBF': 'detection antibody 5 × K₂', '#ADB5BD': 'spare / reference' } };
}
const EXPNOTES = PROTOCOLS.map(expNote);
const ex = n => EXP[n] + ':run';

/* ---------------- the spec ---------------- */
module.exports = {
  slug: 'pe-bead-axr', idTag: 'pb', createdAt: '2026-10-24T12:00:00-07:00',
  device: { id: 'dv_pebead_project', name: 'PE bead project builder' },
  project: { id: 'p_pebeadaxr0', name: 'PE bead assay on the AX R confocal' },
  themes: [
    { id: 't_pebead_bind', name: 'Binding model', question: 'How much PE ends up on an 8 µm capture bead at a given analyte level, and what do the two off-rates do to it?' },
    { id: 't_pebead_img', name: 'Image formation', question: 'What does the AX R record from a shell of PE in one pinhole-set plane, and which number follows the PE count?' },
    { id: 't_pebead_strat', name: 'Measurement strategy', question: 'Which settings and which metric give PE per bead accurately, fast and without depending on focus?' },
    { id: 't_pebead_valid', name: 'Validation on the real system', question: 'Do our AX R and our beads behave as the model says, and which of its numbers have to be measured?' },
  ],
  aims: [
    { id: 'a_pebead_valid', themeId: 't_pebead_valid', statement: 'Pin every model parameter on our AX R and our beads', milestones: [
      { label: 'Exp 01 · power at the sample', weight: 0.06 }, { label: 'Exp 02 · photon transfer', weight: 0.06 }, { label: 'Exp 03 · flat field', weight: 0.04 },
      { label: 'Exp 04 · PSF, edge scan, axial scaling', weight: 0.08 }, { label: 'Exp 05 · bead z-series in four modes', weight: 0.14 }, { label: 'Exp 06 · sampling and field', weight: 0.04 },
      { label: 'Exp 07 · bleaching and saturation', weight: 0.10 }, { label: 'Exp 08 · gain ladder', weight: 0.04 }, { label: 'Exp 09 · backgrounds and NSB', weight: 0.10 },
      { label: 'Exp 10 · PE per bead', weight: 0.08 }, { label: 'Exp 11 · rate constants', weight: 0.10 }, { label: 'Exp 12 · standard curve and hook', weight: 0.10 },
      { label: 'Exp 13 · mode head-to-head', weight: 0.06 }] },
    { id: 'a_pebead_img', themeId: 't_pebead_img', statement: 'Confirm the image model on real beads', milestones: [
      { label: 'Section w(z), its tails and T measured (Exp 04)', weight: 0.3 }, { label: 'F against focus measured on our beads (Exp 05)', weight: 0.4 },
      { label: 'PE linear range and bleaching measured (Exp 07)', weight: 0.3 }] },
    { id: 'a_pebead_bind', themeId: 't_pebead_bind', statement: 'Binding constants for our antibody pair', milestones: [
      { label: 'Λ = k−2 + k−3 measured after the wash', weight: 0.35 }, { label: 'k−2 and k−3 separated (relabel or clamp)', weight: 0.25 },
      { label: 'Standard curve and hook fitted with the model', weight: 0.4 }] },
    { id: 'a_pebead_strat', themeId: 't_pebead_strat', statement: 'A validated routine read', milestones: [
      { label: 'Focus plane and bead optics fixed (Exp 05)', weight: 0.3 }, { label: 'Power cap and detector settings fixed (Exp 01, 02, 07)', weight: 0.2 },
      { label: 'LOD with non-specific binding measured (Exp 09)', weight: 0.25 }, { label: 'Read mode chosen (Exp 13)', weight: 0.25 }] },
  ],
  library: LIBRARY,
  media: {
    fig1: { file: SIM + 'figures/fig1_binding.png', name: 'Binding: coverage, hook, wash, transport.png' },
    fig2: { file: SIM + 'figures/fig2_gallery.png', name: 'Gallery: one bead in every mode.png' },
    fig3: { file: SIM + 'figures/fig3_metrics_vs_z0.png', name: 'Metrics against focus.png' },
    fig4: { file: SIM + 'figures/fig4_sampling.png', name: 'Pixels per bead and sub-pixel position.png' },
    fig5: { file: SIM + 'figures/fig5_photon_budget.png', name: 'Photon budget and bleaching.png' },
    fig6: { file: SIM + 'figures/fig6_gain.png', name: 'Detector gain.png' },
    fig7: { file: SIM + 'figures/fig7_profiles.png', name: 'Radial profiles.png' },
    fig8: { file: SIM + 'figures/fig8_field.png', name: 'Position in the field.png' },
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
  notes: [
    /* ======================================================== overview */
    { key: 'overview', type: 'note', title: 'PE bead assay on the AX R: overview', tags: ['pe-bead', 'overview'],
      synthesis: 'A model of PE on 8 µm sandwich beads and of the AX R image of that PE, a measurement strategy built from it, interactive simulators, a literature review, and 13 experiments that test it. Nothing has been measured on our beads yet.',
      columns: [{ x: 0, w: 560 }, { x: 600, w: 560 }, { x: 1200, w: 560 }],
      sections: [
        { name: 'What this project is', items: [
          T('**The question.** How much PE ends up on an 8 µm capture bead at a given analyte level, and how should the Nikon AX R read it, so that one number per bead follows the analyte?\n\n' +
            '**The assay.** A one-step sandwich. The analyte and the PE-labelled detection antibody go onto the beads together. PE reaches the bead by two routes: the antibody labels analyte the bead has already caught, or analyte and antibody meet in solution and the bead catches the complex. The microscope sees only PE on the bead.\n\n' +
            '**The imaging.** The PE sits on the bead surface, a shell 8 µm across. The confocal records one plane, and the pinhole sets how thick a slice of the bead contributes. A shell images as a ring, not a disc, and that decides how it should be measured.\n\n' +
            '**Where it stands (24 Oct 2026).** The binding model, the image model, three interactive simulators, a measurement strategy, a literature review and 13 experiments are written. None of it has been measured on our beads yet. The next step is the one-day path in [[note:validation|Validating the model]].',
            { key: 'what', label: 'Overview', col: 0 }),
          FIG('setup_assay', { key: 'assay', label: 'The assay', span: [1, 2], caption: 'Two routes put PE on the bead; only the PE on the surface is measured. Rates: capture k₁/k₋₁, labelling on the bead k₂/k₋₂, complex captured k₃/k₋₃, complex in solution k₄/k₋₄.' }),
        ] },
        { name: 'The answer so far', color: '#1baf7a', items: [
          T('Quantify each bead by its integrated intensity F, never by the rim peak.\nF is the sum over the whole bead image minus the background ring. For a shell it follows the PE count and stays within 2 % of its best over ±1.2 µm of focus at 20x, 1 AU, because every slice of a sphere of the same height holds the same surface area (Archimedes’ hat-box theorem). The rim peak loses 12–18 % at 1 µm. See [[note:imagemodel|the image model]].', { key: 'c1', label: 'Claim', col: 0, struct: 'claim' }),
          T('Read at 20x, 1 AU, 1–2 µW at the sample: one plane, one frame, one field of ≈240 beads per well.\nThe 20x section (2.3–2.6 µm) is thinner than the bead, which gives F its flat top, and it collects ≈1.5× more photons per bleaching dose than the 10x. See [[note:strategy|the measurement strategy]].', { key: 'c2', label: 'Claim', col: 0, struct: 'claim' }),
          T('With independent epitopes, PE coverage factors into capture × labelling, and the route PE takes does not change the equilibrium.\n$\\theta_{PE} = \\theta_{cap}\\cdot g$. The route changes only how fast the bead gets there. See [[note:binding|the binding model]].', { key: 'c3', label: 'Claim', col: 1, struct: 'claim' }),
          T('After the wash PE leaves as one exponential, at about $k_{-2}+k_{-3}$, so PE data alone cannot separate the two off-rates.\nRebinding slows it a little, to $f_2k_{-2}+f_3k_{-3}$ [[cite:goldstein1999]]. Experiment 11 separates them with a relabel pulse or a detection-antibody clamp.', { key: 'c4', label: 'Claim', col: 1, struct: 'claim' }),
          T('The limit of detection is set by non-specific PE binding, not by photons.\nPhoton noise alone allows ≈65 PE per bead at 2 µW (≈0.3 PE/µm²), and averaging 100 beads lowers that about tenfold per well. The non-specific background and its spread between wells are unmeasured (Experiment 9).', { key: 'c5', label: 'Claim', col: 2, struct: 'claim' }),
          T('The flat focus response holds for an index-matched bead; a polystyrene bead may break it.\nA bead that bends light lowers F near the equator and makes it lopsided against focus, and surface-labelled polystyrene particles lose their far hemisphere in confocal images [[cite:vorselen2020]]. Experiment 5 measures it on our beads.', { key: 'c6', label: 'Claim', col: 2, struct: 'claim', stance: 'contested' }),
          T('Saturation is not the limit at 1–2 µW.\nSolved point by point, F stays within 5 % of linear up to ≈5–6 µW at 20x. The default stays at 1–2 µW until Experiment 7 measures PE’s millisecond dark state on our beads [[cite:gaigalas2006]].', { key: 'c7', label: 'Claim', col: 2, struct: 'claim' }),
        ] },
        { name: 'Open questions', color: '#eda100', items: [
          T('What are our beads made of, and what is their refractive index?\nPolystyrene, PMMA, silica or magnetic. It sets how much the bead bends light, and so where to focus and how flat F is. Ask the vendor; then Experiment 5.', { key: 'q1', label: 'Question', col: 0, struct: 'question' }),
          T('Which 20x objective is fitted: NA 0.75 or 0.80?\nRead it off the barrel. The section and the collection differ by ≈15 %.', { key: 'q2', label: 'Question', col: 0, struct: 'question' }),
          T('How fast does PE leave our beads after the wash (Λ = k₋₂ + k₋₃)?\nIt decides whether a plate can be washed in one go or must be washed column by column.', { key: 'q3', label: 'Question', col: 0, struct: 'question' }),
          T('How much PE-antibody sticks to the beads non-specifically, and how much does it vary between wells?\nThis sets the real limit of detection and the detection-antibody level.', { key: 'q4', label: 'Question', col: 1, struct: 'question' }),
          T('Where does PE stop being linear on our beads?\nThe model says above ≈5 µW for F; PE’s dark state could bring it lower.', { key: 'q5', label: 'Question', col: 1, struct: 'question' }),
          T('How thick is the real optical section, and how heavy are its tails?\nThe tails set how wide the flat part of F is, the free-PE background and the absolute calibration.', { key: 'q6', label: 'Question', col: 1, struct: 'question' }),
          T('How many PE molecules is one unit of F?\nNeeded to report PE per bead, and to compare with flow cytometry.', { key: 'q7', label: 'Question', col: 1, struct: 'question' }),
          FIG('setup_validation', { key: 'valmap', label: 'Which experiment pins which part', col: 2, caption: 'Filled dot: the experiment that measures it. Ring: one that checks it. Right: the protocol choice the result sets.' }),
        ] },
        { name: 'In this project', color: '#6250d6', items: [
          { kind: 'noteref', key: 'r1', note: 'binding', col: 0, w: 540 }, { kind: 'noteref', key: 'r2', note: 'imagemodel', col: 1, w: 540 }, { kind: 'noteref', key: 'r3', note: 'simresults', col: 2, w: 540 },
          { kind: 'noteref', key: 'r4', note: 'strategy', col: 0, w: 540 }, { kind: 'noteref', key: 'r5', note: 'validation', col: 1, w: 540 }, { kind: 'noteref', key: 'r6', docId: LR_DOC, title: 'PE bead assay model — lit review', col: 2, w: 540 },
          { kind: 'noteref', key: 'r7', note: 'setupaxr', col: 0, w: 540 }, { kind: 'noteref', key: 'r8', note: 'setupassay', col: 1, w: 540 },
          T('**Files behind this project** (McGheeLabWebsite repo):\n• report: Research/PE_bead_confocal_assay_model.md\n• experiments: Research/PE_bead_confocal_experiments.md\n• RM protocols: Research/bead_confocal_protocols/\n• simulator: Research/bead_confocal_sim/ (params.py holds every number)\n• interactive pages: Research/bead_confocal_sim/interactive/\n• literature review: Research/PE_bead_confocal_litreview.md\n• this project: Research/bead_confocal_scientia/', { key: 'files', label: 'Where the work lives', col: 2, w: 540 }),
        ] },
      ] },

    /* ======================================================== binding */
    { key: 'binding', type: 'analysis', themeId: 't_pebead_bind', title: 'Binding model: PE on the bead against analyte', tags: ['pe-bead', 'model'],
      header: { dataset: 'simulation · Research/bead_confocal_sim', code: 'V3.893 · params.py' },
      synthesis: 'A one-step sandwich on 8 µm beads, solved with mass action, finite sites, depletion and transport. PE coverage factors into capture × labelling; the detection-antibody level sets the ceiling, the hook and most of the design.',
      sections: [
        { name: 'Species and reactions', items: [
          T('**Species.** A free analyte; D free PE-detection antibody; AD their complex in solution; SA analyte on a capture site; **SAD the full sandwich, the only thing the microscope sees**; S free capture sites, $S = S_T - SA - SAD$.\n\n' +
            '**Reactions** (mass action, one analyte per site):\n• capture: $A + S \\rightleftharpoons SA$ ($k_1$, $k_{-1}$)\n• labelling on the bead: $D + SA \\rightleftharpoons SAD$ ($k_2$, $k_{-2}$)\n• complex captured: $AD + S \\rightleftharpoons SAD$ ($k_3$, $k_{-3}$)\n• complex formed in solution: $A + D \\rightleftharpoons AD$ ($k_4$, $k_{-4}$)\n\n' +
            'Detailed balance ties them: $K_1K_2 = K_3K_4$. With independent epitopes $k_3 = k_1$, $k_{-3} = k_{-1}$, $k_4 = k_2$, $k_{-4} = k_{-2}$.', { key: 'species', label: 'Model', col: 0 }),
          T('**Assumptions** (each one to be checked):\n• one analyte per capture site, one detection antibody per analyte;\n• the detection antibody binds captured and free analyte alike;\n• about one PE per detection antibody;\n• the beads stay suspended and mixed during the incubation;\n• the wash removes everything in solution;\n• no non-specific binding in the model itself: it is measured in Experiment 9.', { key: 'assume', label: 'Assumptions', col: 0 }),
          FIG('setup_assay', { key: 'fig', label: 'The two routes', col: 1 }),
        ] },
        { name: 'Equations', items: [
          T('**Rates per bead** (molecules per bead per second), each slowed by transport:\n$$r_1 = f_1\\left(k_1 A S - k_{-1} SA\\right)\\qquad r_2 = f_2\\left(k_2 D\\,SA - k_{-2} SAD\\right)$$\n$$r_3 = f_3\\left(k_3\\,AD\\,S - k_{-3} SAD\\right)\\qquad r_4 = k_4 A D - k_{-4} AD$$\n' +
            '**Solution and surface balances**, with $c_b = n_b/(N_A V)$ the concentration of one molecule per bead:\n$$\\frac{dA}{dt} = -c_b r_1 - r_4\\qquad \\frac{dD}{dt} = -c_b r_2 - r_4\\qquad \\frac{dAD}{dt} = r_4 - c_b r_3$$\n$$\\frac{dSA}{dt} = r_1 - r_2\\qquad \\frac{dSAD}{dt} = r_2 + r_3$$\n' +
            '**Transport** (Berg–Purcell partial absorber) [[cite:bergpurcell1977]] [[cite:goldsteindembo1995]]:\n$$f = \\frac{k_D}{k_D + k_{on} N_{free}}\\qquad k_D = 4\\pi D R N_A$$\nIt slows binding and unbinding alike and leaves the equilibrium where it was.\n\n' +
            '**After the wash** nothing is left in solution, and SAD loses PE through both bonds: $\\frac{dSAD}{dt} = -(f_2k_{-2} + f_3k_{-3})\\,SAD$.', { key: 'odes', label: 'Mass action with transport', col: 0 }),
          { kind: 'eq', key: 'eq_kd', label: 'Diffusion-limited rate per bead', tex: 'k_D=4\\pi D R N_A', vars: { k_D: ['rate constant per bead', 'M⁻¹ s⁻¹'], D: ['diffusion coefficient', 'm² s⁻¹'], R: ['bead radius', 'm'], N_A: ['Avogadro constant', 'mol⁻¹'] }, col: 1, w: 430 },
          { kind: 'eq', key: 'eq_da', label: 'Damköhler number of an empty bead', tex: 'D_a=\\frac{k_{on}N_S}{k_D}', vars: { D_a: ['Damköhler number', ''], k_on: ['on-rate', 'M⁻¹ s⁻¹'], N_S: ['capture sites per bead', ''], k_D: ['diffusion-limited rate per bead', 'M⁻¹ s⁻¹'] }, col: 1, w: 430, dx: 0 },
          { kind: 'eq', key: 'eq_ceil', label: 'PE ceiling with excess analyte', tex: 'N_{max}=\\frac{S_T D_T}{K_2+D_T}', vars: { N_max: ['PE per bead at the ceiling', ''], S_T: ['capture sites per bead', ''], D_T: ['detection antibody', 'M'], K_2: ['detection K_D', 'M'] }, col: 1, w: 430 },
          { kind: 'eq', key: 'eq_kapp', label: 'Apparent K_D of the PE isotherm', tex: 'K_{app}=\\frac{K_1K_2}{K_2+D_T}', vars: { K_app: ['apparent K_D', 'M'], K_1: ['capture K_D', 'M'], K_2: ['detection K_D', 'M'], D_T: ['detection antibody', 'M'] }, col: 1, w: 430 },
          { kind: 'eq', key: 'eq_half', label: 'Post-wash half-life', tex: 't_h=\\frac{\\ln 2}{\\Lambda}', vars: { t_h: ['half-life of PE on the bead', 's'], 'Λ': ['decay rate k₋₂ + k₋₃', 's⁻¹'] }, col: 1, w: 430 },
          { kind: 'calc', key: 'calc', label: 'Binding numbers', col: 1, w: 430 },
        ] },
        { name: 'What the model says', color: '#1baf7a', items: [
          T('PE coverage factors into capture × labelling.\n$\\theta_{PE} = \\theta_{cap}\\cdot g$: the share of sites holding analyte, times the share of all analyte that carries a detection antibody. Exact at equilibrium, and at all times when the rate constants match. The route PE takes changes only the kinetics.', { key: 'r1', label: 'Result', col: 0, struct: 'claim' }),
          T('The detection antibody sets the ceiling, and its conservation makes the one-step hook.\nThe maximum is about $\\min(S_T, D_T)$; the fall starts at $A_T \\approx \\max(S_T + K_1,\\ D_T + K_2)$; beyond it $SAD \\approx S_T D_T/(A_T + K_2)$ [[cite:fernandowilson1992]] [[cite:saateh2026]]. In the reference case the peak sits at ≈0.6–0.7 nM at equilibrium and moves to ≈2 nM after a 1 h incubation.', { key: 'r2', label: 'Result', col: 0, struct: 'claim' }),
          T('An 8 µm bead is in mixed transport–reaction control.\n$k_D \\approx 0.9$–$2.6\\times10^{12}$ M⁻¹ s⁻¹ per bead and the Damköhler number is 0.05–3, highest for the large analyte–antibody complex [[cite:chang2012]] [[cite:goldstein1999]].', { key: 'r3', label: 'Result', col: 0, struct: 'claim' }),
          T('Practical incubations are not at equilibrium, and the number of beads sets the clock.\nCapture runs at $k_{cap} = c_b k_{bead}$. In the reference case 1 h captures ≈35 % of the analyte and the signal roughly doubles from 1 h to 3 h. Where the beads deplete the analyte, PE per bead ∝ $A_T V/n_b$: bead number is a calibration parameter [[cite:rissin2010]].', { key: 'r4', label: 'Result', col: 0, struct: 'claim' }),
          T('After the wash PE decays as one exponential, so PE alone cannot separate the two off-rates.\nThe rate is $f_2k_{-2} + f_3k_{-3}$, a few per cent below $k_{-2}+k_{-3}$ because of rebinding; at high coverage the tail need not stay exponential [[cite:goldstein1999]]. A relabel pulse or a detection-antibody clamp separates them (Experiment 11).', { key: 'r5', label: 'Result', col: 0, struct: 'claim' }),
          T('Use a detection-antibody level of about 1–2 × K₂.\nIt sets the sensitivity to k₋₂, the hook position, the no-wash background and the non-specific background. Go to 2–5 × K₂ only if Experiment 9 shows non-specific binding is negligible.', { key: 'r6', label: 'Decision', col: 0, struct: 'decision' }),
          T('PE density has a steric ceiling of ≈0.35–1.2 × 10⁶ PE per bead (1,700–5,800 PE/µm²).\nAt pM analyte the bead carries only ≈1–10 PE/µm².', { key: 'r7', label: 'Result', col: 0, struct: 'claim' }),
          FIG('fig1', { key: 'fig1', label: 'Binding in the reference case', col: 1, caption: '(a) Coverage against analyte at three detection-antibody levels, with the no-depletion closed form dashed. (b) The one-step hook. (c) PE after the wash at three detection off-rates. (d) Transport: the same curves with diffusion switched off.' }),
        ] },
        { name: 'Interactive: the binding simulator', color: '#6250d6', items: [
          { kind: 'html', key: 'sim', media: 'sim_binding', label: 'Binding simulator', col: 'full', w: 1460, h: 900 },
          T('A port of `binding.py`, solved with a stiff integrator; it agrees with the Python within 0.06 % in every case checked (`interactive/tools/check_binding.py`). Tabs: dose–response with the hook and the reportable range; the time course through the wash; design sweeps of detection antibody and bead number; the model in words. Presets: the reference case, a slow label off-rate, 10⁵ beads, a high detection-antibody level. Use the corner button to maximise.', { key: 'simnote', label: 'About the simulator', col: 0 }),
        ] },
        { name: 'Reference parameters and the literature', color: '#eb6834', items: [
          T('**Reference case** (report A.2.4; `params.BINDING`):\n• capture sites $S_T$: 10⁶ per bead (range 3 × 10⁵–3 × 10⁶)\n• beads: 10⁴ in 50 µL ($c_b$ = 3.3 × 10⁻¹⁶ M per molecule per bead; capacity 332 pM)\n• capture: $k_1$ = 5 × 10⁵ M⁻¹ s⁻¹, $k_{-1}$ = 10⁻⁵ s⁻¹ ($K_1$ = 20 pM)\n• detection: $k_2$ = 4 × 10⁵ M⁻¹ s⁻¹, $k_{-2}$ = 8.6 × 10⁻⁴ s⁻¹ ($K_2$ = 2.15 nM); bead fits give ≈10⁻⁴ s⁻¹ [[cite:chang2012]]\n• detection antibody $D_T$: 2 nM\n• diffusion: analyte 6, antibody 3.5, complex 3 × 10⁻⁷ cm² s⁻¹\n• result: 498 PE per bead at 1 pM after 1 h; Damköhler 0.28 (analyte), 0.38 (antibody)', { key: 'params', label: 'Parameters', col: 0 }),
          { kind: 'noteref', key: 'lr', docId: LR_DOC, focusId: lr('fA2'), col: 1, w: 560 },
          { kind: 'noteref', key: 'lr2', docId: LR_DOC, focusId: lr('vA'), col: 1, w: 560 },
        ] },
      ] },

    /* ======================================================== image model */
    { key: 'imagemodel', type: 'analysis', themeId: 't_pebead_img', title: 'Image model: a PE shell in one confocal plane', tags: ['pe-bead', 'model', 'optics'],
      header: { dataset: 'simulation · Research/bead_confocal_sim', code: 'V3.893 · params.py' },
      synthesis: 'A thin shell of PE images as a ring. Its integrated intensity F follows the PE count and, while the section is thinner than the bead, barely moves with focus. How the bead itself bends light is the main thing that could break this.',
      sections: [
        { name: 'A shell is not a filled bead', items: [
          T('The PE is on the surface only. A confocal plane cuts the shell where it runs steeply, so a rim pixel looks through the shell edge-on and holds ≈5–6× the PE of a flat sheet; the centre is dark. A filled bead with the same PE gives a flat disc.\n\n' +
            '**Projected density** of a thin shell before the lateral blur, with $w(z)$ the weight of the optical section:\n$$P(\\rho)=\\frac{\\sigma_s R}{\\sqrt{R^2-\\rho^2}}\\left[w\\left(z_0-\\sqrt{R^2-\\rho^2}\\right)+w\\left(z_0+\\sqrt{R^2-\\rho^2}\\right)\\right]$$\n' +
            '**Integrated intensity.** Every slice of a sphere of height dz holds the same shell area, $2\\pi R\\,dz$ (Archimedes’ hat-box theorem), so\n$$F = 2\\pi R\\,\\sigma_s\\int_{-R}^{R} w(z-z_0)\\,dz$$\nWhile the section lies inside the bead, F does not depend on where it is.', { key: 'shell', label: 'Model', col: 0 }),
          T('F stays within 2 % of its best over ±1.2 µm of focus at 20x, 1 AU; the rim peak loses 12–18 % at 1 µm.\nAt 10x, 1 AU the section is about as thick as the bead and F loses ≈2 % at 1 µm. Index-matched bead.', { key: 'claimF', label: 'Result', col: 0, struct: 'claim' }),
          FIG('setup_section', { key: 'fig', label: 'How one plane sees a shell', col: 1 }),
          { kind: 'eq', key: 'eq_F', label: 'Integrated intensity of a shell', tex: 'F=2\\pi R\\sigma_s\\ell', vars: { F: ['integrated intensity', 'PE-equivalents'], R: ['bead radius', 'µm'], 'σ_s': ['PE surface density', 'PE µm⁻²'], 'ℓ': ['section integral ∫w dz over the bead', 'µm'] }, col: 1, w: 430 },
        ] },
        { name: 'The PSF and the optical section', items: [
          T('The PSF is a Gaussian excitation beam times the share of each molecule’s defocused emission spot that passes the pinhole:\n$$h(\\rho,z) = \\left(\\frac{w_0}{w(z)}\\right)^2 e^{-2\\rho^2/w(z)^2}\\cdot D_{ph}(\\rho,z)$$\nwith $w_0 = 0.433\\,\\lambda_{ex}/\\mathrm{NA}$, $w(z) = w_0\\sqrt{1+(z/z_R)^2}$, $z_R = \\pi w_0^2 n/\\lambda_{ex}$, and a pinhole of radius $a = \\mathrm{AU}\\cdot 1.22\\,\\lambda_{em}/(2\\,\\mathrm{NA})$ at the sample. Its tails fall as $1/z^2$.\n\n' +
            '**Two section widths, not one.** The on-axis width is what a point on the axis sees. The plane-integrated width is what a sheet of PE sees, and it is what sets F. At 1 AU they differ by ≈1.7×, at 4 AU by 6–7×.', { key: 'psf', label: 'Model', col: 0 }),
          T('**Sections at 1 AU** (plane-integrated / on-axis FWHM):\n• 20x/0.80: 2.3 / 1.3 µm\n• 20x/0.75: 2.6 / 1.5 µm\n• 10x/0.45: 7.1 / 4.0 µm (at least 4.6 µm even with the pinhole closed)\n\nEffective detection volume at 1 AU: 0.41 µm³ (20x/0.80), 0.53 µm³ (20x/0.75), 3.7 µm³ (10x). Free PE in the buffer scales with it. One pinhole number hides the two widths; Experiment 4 measures both.', { key: 'widths', label: 'Numbers', col: 0 }),
          FIG('fig7', { key: 'fig7', label: 'Radial profiles against focus', col: 1, caption: 'Noise-free ring profiles at 40 px per bead as the focal plane moves from the equator (z₀ = 0) towards the top of the bead.' }),
        ] },
        { name: 'Photons, saturation and bleaching', items: [
          T('**Inputs.** R-PE ε ≈ 1.96 × 10⁶ M⁻¹ cm⁻¹ (σ ≈ 7.5 × 10⁻¹⁵ cm² at 561 nm), quantum yield 0.82, lifetime 2.7 ns, photodestruction 1.1 × 10⁻⁵ per absorbed photon (6.5 × 10⁻⁶ with n-propyl gallate) [[cite:whitestryer1987]] [[cite:oi1982]] [[cite:mathies1990]].\n' +
            '**Detection.** Collection in water × 0.4 optics × 0.4 GaAsP QE ≈ 1.4–1.6 % at 20x.\n' +
            '**At 2 µW, 2 µs, 0.43 µm pixels (20x/0.80):** ≈0.18 photoelectrons per PE per frame, so a bead with 500 PE gives ≈90 photoelectrons and a rim pixel about one; 0.05 % of the PE bleaches per frame; each PE gives ≈340–370 detected photons before it bleaches.', { key: 'budget', label: 'Photon budget', col: 0 }),
          T('Bleaching is a pure gain error in one plane.\nOne-photon excitation gives every plane the full beam, so a raster delivers the same dose to every PE on the bead, top to bottom. Fix the frames and the power, and never focus in PE.', { key: 'bleach', label: 'Result', col: 0, struct: 'claim' }),
          T('**Saturation.** The first-order estimate (an in-focus sheet, Gaussian weighting) puts 5 % sublinearity at ≈2 µW (20x) and 6–7 µW (10x). Solved point by point with the repo PSF, each molecule saturating at its own irradiance:\n• in-focus sheet: 2.5–2.9 µW (20x), 8 µW (10x)\n• rim peak of a shell: 3.0–3.3 µW (20x)\n• **integrated F of a shell: 5.3–5.9 µW (20x), 12 µW (10x)**, because much of F comes from molecules away from the focal plane\n' +
            'PE’s millisecond dark state is not in the model and brings these down [[cite:gaigalas2006]] [[cite:doornbos1997]]. Keep 1–2 µW until Experiment 7 measures it.', { key: 'sat', label: 'Saturation', col: 0 }),
          FIG('fig5', { key: 'fig5', label: 'Photon budget', col: 1, caption: '(a) SNR of F in one frame against dwell at four powers. (b) PE lost per frame. (c) SNR bought per per cent bleached: one line in the linear regime. (d) Linearity from the detector floor to 5,000 PE/µm² at 2 µW.' }),
          { kind: 'eq', key: 'eq_I0', label: 'Peak irradiance of the beam', tex: 'I_0=\\frac{2P}{\\pi w_0^2}', vars: { I_0: ['peak irradiance', 'W m⁻²'], P: ['power at the sample', 'W'], w_0: ['beam waist', 'm'] }, col: 1, w: 430 },
          { kind: 'eq', key: 'eq_dose', label: 'Absorptions per PE per frame', tex: 'D_f=\\frac{\\sigma P\\tau}{p^2 E}', vars: { D_f: ['absorptions per PE per frame', ''], 'σ': ['absorption cross-section', 'm²'], P: ['power at the sample', 'W'], 'τ': ['pixel dwell', 's'], p: ['pixel size', 'm'], E: ['photon energy hc/λ', 'J'] }, col: 1, w: 430 },
          { kind: 'calc', key: 'calc', label: 'Photon numbers', col: 1, w: 430 },
        ] },
        { name: 'The bead’s own optics (open)', color: '#e34948', items: [
          T('A polystyrene, PMMA or silica bead in water bends light, and that can break the flat-focus result.\nA geometric ray trace puts the equatorial signal at ≈0.6–0.75 of an index-matched bead at 20x and makes F lopsided about the equator. It counts light that reaches the objective, not light that passes the pinhole: surface-labelled polystyrene particles lose their far hemisphere in confocal images [[cite:vorselen2020]], while index-matched hydrogel particles do not [[cite:darafsheh2021]]. Experiment 5 measures F against focus on our beads; focus at the measured flat point.', { key: 'barrier', label: 'Barrier', col: 0, struct: 'barrier' }),
          { kind: 'noteref', key: 'lr', docId: LR_DOC, focusId: lr('fD2'), col: 1, w: 560 },
          { kind: 'noteref', key: 'lr2', docId: LR_DOC, focusId: lr('vD'), col: 1, w: 560 },
        ] },
        { name: 'Interactive: the confocal simulator', color: '#6250d6', items: [
          { kind: 'html', key: 'sim', media: 'sim_confocal', label: 'Confocal simulator', col: 'full', w: 1460, h: 900 },
          T('`optics.py` ported to the page and checked against it: PSF, H(z) and F within 0.2 %, the rendered F and rim peak within 0.6 % (`interactive/tools/check_confocal.py`). Every setting from the brief: objective, pinhole, laser, gain, PE density, bleaching, pixels per bead, dwell, focal offset, position on the pixel grid and in the field. Also: a filled bead for comparison, bead material (ray-trace estimate), free PE in the buffer, autofluorescence. Tabs: image, focus, optical section, photons and bleaching.', { key: 'simnote', label: 'About the simulator', col: 0 }),
        ] },
        { name: 'Backgrounds and the detector', items: [
          T('**Free PE-antibody** left in the buffer (a no-wash read) images as a sheet of $c\\,\\ell_{eff}$: 1.8–2.65 PE/µm² per nM at 20x/0.80 and 5.9–8.7 at 10x, in every pixel. The bead displaces the buffer, so subtracting the background ring over-subtracts by ≈1 PE/µm² per nM (excluded volume) [[cite:waters2009]].\n\n' +
            '**Detector.** Poisson photoelectrons, PMT excess noise 1.2–1.56, offset and read noise; 12-bit by default. Clip nothing. Convert DN to photoelectrons by photon transfer at each HV (Experiment 2) [[cite:murray2007]].\n\n' +
            '**Field.** Illumination falls ≥ 10 % from the centre to the corner: flat-field every session (Experiment 3) [[cite:jonkman2020]].', { key: 'bg', label: 'Model', col: 0 }),
          FIG('fig9', { key: 'fig9', label: 'Backgrounds and the LOD', col: 1, caption: 'Per-bead LOD (3 SD of a blank bead, integrated F, 2 µW, 2 µs) against free PE-antibody in the buffer and against bead autofluorescence.' }),
        ] },
      ] },

    /* ======================================================== simulation results */
    { key: 'simresults', type: 'analysis', themeId: 't_pebead_img', title: 'Simulation results: what each AX R setting does', tags: ['pe-bead', 'simulation'],
      header: { dataset: 'simulation · Research/bead_confocal_sim', code: 'V3.893 · params.py' },
      synthesis: 'The repo simulator, regenerated at the recommended 2 µW: every AX R setting from the brief and what it does to the integrated F and to the ring.',
      sections: [
        { name: 'One bead in every mode', items: [
          T('σ = 1,000 PE/µm² (≈2 × 10⁵ PE), 2 µW, 2 µs, 20 px per bead; focal plane at the equator, 2 µm and 3.5 µm above it.\n• The rim peak sits at r ≈ 3.8–3.9 µm; the blur pulls it 0.1–0.2 µm inside R.\n• Rim/centre at the equator: **17.6 at 20x 1 AU**, 5.2 at 10x 1 AU, 2.9 at 10x 2 AU, 3.6 at 20x 4 AU. A filled bead with the same PE gives ≈1.1.\n• Part B’s Gaussian section predicts > 500 at 20x 1 AU: the difference is the PSF tails, which Experiment 5 measures.\n• Ring radius follows √(R² − z₀²) only beyond z₀ ≈ 2.5 µm. **Ring radius is a poor focus sensor; rim brightness is a sensitive one.**', { key: 'gallery_t', label: 'Results', col: 0 }),
          FIG('fig2', { key: 'gallery_f', label: 'Gallery', col: 1 }),
        ] },
        { name: 'Focal-plane offset', items: [
          T('**F within 5 % of its best**, and the loss of the ring-mean / rim peak at a 2 µm error:\n• 20x, 1 AU: ±1.75 µm; 27 % / 30 %\n• 20x, 2 AU: ±1.5 µm; 26 % / 30 %\n• 20x, 4 AU: ±1.5 µm; 21 % / 23 %\n• 10x, 1 AU: ±1.5 µm; 17 % / 21 %\n• 10x, 2 AU: ±1.75 µm; 9 % / 13 %\n• 10x, 4 AU: ±4.5 µm (−2.2 % at the ends); 7 % / 10 %\n\n**Two focus-tolerant regimes.** A section much thinner than the bead (20x, 1 AU) gives F a flat top while the section lies inside the bead. A section much thicker than the bead (10x, ≥ 4 AU) puts the whole bead in the flat top of the plane response. The worst case is a section about as thick as the bead.', { key: 'focus_t', label: 'Results', col: 0 }),
          T('Use the ring-mean and the rim peak only for quality control, never as the quantity.\nThey lose 7–30 % at a 2 µm focus error in every mode.', { key: 'focus_d', label: 'Decision', col: 0, struct: 'decision' }),
          FIG('fig3', { key: 'focus_f', label: 'Metrics against focus', col: 1, caption: '(a) Integrated F, (b) ring mean, (c) rim peak, (d) apparent ring radius against focal offset, for 20x and 10x at 1, 2 and 4 AU. Noise-free, 20 px per bead.' }),
        ] },
        { name: 'Pixels per bead and sub-pixel position', items: [
          T('**Swing over sub-pixel offsets of 0–0.5 px** (20x, 1 AU): rim peak / ring mean / integrated F\n• 8 px per bead (1.00 µm): 28 % / 15 % / 4.6 %\n• 12 px (0.67 µm): 39 % / 14 % / 1.5 %\n• 20 px (0.40 µm): 14 % / 6.7 % / 0.13 %\n• 40 px (0.20 µm): 2.8 % / 2.6 % / < 0.01 %\n\nAt a fixed dwell, photons and dose per frame both scale as (px per bead)²: finer pixels are a longer exposure, not more information about F. Coarse pixels buy beads per frame.', { key: 'sampling_t', label: 'Results', col: 0 }),
          T('12–16 pixels per bead are enough for F.\nThe rim peak needs ≥ 40; F does not.', { key: 'sampling_c', label: 'Result', col: 0, struct: 'claim' }),
          FIG('fig4', { key: 'sampling_f', label: 'Sampling', col: 1 }),
        ] },
        { name: 'Laser power, dwell and bleaching', items: [
          T('**20x, 1 AU, 100 PE/µm², 2 µs, one frame:** emission per PE at the focus / SNR of F / PE lost per frame\n• 1 µW: 1.0 × 10⁷ s⁻¹ / 40 / 0.029 %\n• 3 µW: 2.9 × 10⁷ / 66 / 0.087 %\n• 10 µW: 7.8 × 10⁷ / 110 / 0.29 %\n• 30 µW: 1.5 × 10⁸ / 155 / 0.87 %\n\nIn the linear regime SNR against fraction bleached is one line, whatever the split between power and dwell. Saturation bends it: above ≈5 µW each per cent bleached buys less SNR. Detected photons per PE over its life ≈340 at 2 µW; a 5 % bleach budget is ≈17 per PE.', { key: 'power_t', label: 'Results', col: 0 }),
          FIG('fig5', { key: 'power_f', label: 'Photon budget', col: 1 }),
        ] },
        { name: 'Detector gain', items: [
          T('Gain (DN per photoelectron) leaves F in photoelectrons and the bead-to-bead CV unchanged until rim pixels clip; clipping then cuts F fast. At 2 µW and 16 bits, clipping starts at ≈100 DN per photoelectron for 3,000 PE/µm² and ≈500 for 300 PE/µm². In the default 12-bit mode every threshold is 16× lower.', { key: 'gain_t', label: 'Results', col: 0 }),
          T('Set one gain per plate from the brightest standard (rim at 70–80 % of full scale) and never change it within the plate.', { key: 'gain_d', label: 'Decision', col: 0, struct: 'decision' }),
          FIG('fig6', { key: 'gain_f', label: 'Gain', col: 1 }),
        ] },
        { name: 'Position in the field', items: [
          T('With 15 % vignetting at the edge and 1–3 µm of field curvature, F loses only the vignetting plus a little curvature: −16 % at the edge with 1 µm, −30 % with 3 µm. The ring mean loses about half. Real fall-off is ≥ 10 % centre to corner on most systems [[cite:jonkman2020]]. Flat-field every session and keep beads where the correction is < 1.25×.', { key: 'field_t', label: 'Results', col: 0 }),
          FIG('fig8', { key: 'field_f', label: 'Field', col: 1 }),
        ] },
        { name: 'Backgrounds and the limit of detection', items: [
          T('**LOD in PE per bead** (3 × shot-noise SD of a blank bead, F, 2 µW, 2 µs, 20 px per bead): washed / free PE-antibody 0.1, 1, 10 nM / autofluorescence 0.1, 1, 10 PE-eq per µm³\n• 20x, 1 AU: 66 / 94, 220, 668 / 80, 158, 460\n• 10x, 1 AU: 99 / 136, 311, 938 / 111, 190, 524\n• 10x, 4 AU: 65 / 125, 344, 1,071 / 76, 141, 402\n\nThese match the report’s `lod.py` (64–66 / 91–93 / 214–220 / 649–666 at 20x). The 20x at 1 AU has the smallest detection volume and suffers least in a no-wash read. In practice the floor is non-specific binding (Experiment 9).', { key: 'lod_t', label: 'Results', col: 0 }),
          FIG('fig9', { key: 'lod_f', label: 'Backgrounds', col: 1 }),
        ] },
        { name: 'Every setting at a glance', color: '#6250d6', items: [
          T('• **Pinhole:** the plane-integrated section grows ∝ AU. Focus tolerance is best at ≤ 1 AU (20x) or ≥ 4 AU (10x). → 20x at 1 AU.\n• **Laser power:** F is 5 % sublinear at ≈5–6 µW (20x) solved point by point, ≈2 µW by the Gaussian estimate; bleaching ∝ dose. → 1–2 µW measured at the sample.\n• **Gain:** no effect on SNR or CV until clipping. → one gain per plate, from the brightest standard.\n• **PE density:** linear from the LOD (≈0.3 PE/µm²) to clipping. → calibrate PE per unit of F.\n• **Bleaching:** a uniform gain loss, ≈0.06 % per frame at 2 µW. → one frame per field; focus in transmitted light.\n• **Pixels per bead:** F is stable from 12 px. → 12–20 px per bead.\n• **Dwell:** SNR ∝ √dwell, dose ∝ dwell. → 2 µs galvano.\n• **Focal offset:** a flat top of ±1.75 µm at 20x, 1 AU. → Perfect Focus at the measured flat point.\n• **Position on the grid and in the field:** < 1.5 % sub-pixel at ≥ 12 px; vignetting plus curvature in the field. → flat-field; use the central region.\n• **Objective:** 10x has a 4× larger field and more cap signal; 20x has the thinner section and the best no-wash LOD. → 20x by default; 10x if Experiment 13 says so.', { key: 'all_t', label: 'Summary', col: 'full', w: 1460 }),
        ] },
      ] },

    /* ======================================================== strategy */
    { key: 'strategy', type: 'planning', themeId: 't_pebead_strat', title: 'Measurement strategy: how to read the beads', tags: ['pe-bead', 'strategy'],
      synthesis: '20x at 1 AU, 1–2 µW at the sample, one plane at the measured flat point of F, beads found in transmitted light, F per bead, the median of ≥ 100 beads per well, a fixed delay from wash to image.',
      columns: [{ x: 0, w: 540 }, { x: 580, w: 540 }, { x: 1160, w: 760 }],
      sections: [
        { name: 'The recommended read', items: [
          T('Objective: 20x at 1 AU by default; 10x as a throughput mode only if Experiment 13 says so.\nThe 20x section (2.3–3.2 µm) is thinner than the bead, so F has a flat top; it collects ≈1.5× more photons per bleaching dose and sees ≈3× less free-PE background per nM [[cite:jonkman2020]]. At 1 AU the 10x is the least focus-tolerant mode; open it to 3–4 AU if NIS-Elements allows.', { key: 'd1', label: 'Decision', col: 0, struct: 'decision' }),
          T('Laser: 561 nm at 1–2 µW measured at the sample; never set power in % laser.\nF stays within 5 % of linear to ≈5 µW in the model; PE’s dark state is not in it, so the default keeps a margin until Experiment 7.', { key: 'd2', label: 'Decision', col: 0, struct: 'decision' }),
          T('One plane, one frame, one field per well, at the measured flat point of F.\nHold it with a Perfect Focus offset. That is the equator only for an index-matched bead.', { key: 'd3', label: 'Decision', col: 0, struct: 'decision' }),
          T('Find beads and judge focus in transmitted light, never in PE.\nSegmenting on PE picks the bright beads at the low end and biases the low standards upward. The transmitted channel costs no PE dose.', { key: 'd4', label: 'Decision', col: 0, struct: 'decision' }),
          T('Quantify F per bead: the sum within R + 2.5 µm minus the background ring, normalised by R; the median of ≥ 100 beads per well; ≥ 2 wells per condition.\nReject doublets, touching beads and beads at the edge of the field.', { key: 'd5', label: 'Decision', col: 0, struct: 'decision' }),
          T('Scan: galvano 2 µs, 2048² at zoom 1 (0.43 µm pixels, ≈18.5 per bead).\nHV so the brightest standard’s rim sits at 70–80 % of full scale; offset keeps the background above 0; emission ≈575–650 nm on a GaAsP channel.', { key: 'd6', label: 'Decision', col: 1, struct: 'decision' }),
          T('Settle the beads with a 1 min plate spin at 100–300 g, not by gravity.\nGravity takes ≈15 min through a 1.5 mm fill, most of a 10 min imaging window.', { key: 'd7', label: 'Decision', col: 1, struct: 'decision' }),
          T('Hold a fixed, logged delay from wash to image, and stagger the wash by column when the post-wash loss is fast.\nΛ ≲ 2 × 10⁻⁴ s⁻¹: one wash for the plate, randomised order. 2 × 10⁻⁴–10⁻³ s⁻¹: column-staggered washes, each column imaged 5 ± 0.5 min after its wash. Λ ≳ 10⁻³ s⁻¹: read without a wash.', { key: 'd8', label: 'Decision', col: 1, struct: 'decision' }),
          T('Detection antibody at 1–2 × K₂.\nGo higher only if Experiment 9 shows the non-specific background is negligible; switch to a two-step format if the hook lies within 10× of the expected sample range.', { key: 'd9', label: 'Decision', col: 1, struct: 'decision' }),
          T('Fit a mechanistic or 5PL-with-hook curve; run unknowns at 1× and 10×.\n≥ 8 standards spanning the hook plus blanks, weighted by the measured variance; LOD = blank + 3 SD of blank well means; report only where |d ln N / d ln A| ≥ 0.5.', { key: 'd10', label: 'Decision', col: 1, struct: 'decision' }),
          T('Report absolute PE per bead from a solution-PE reference with the measured T, checked by flow cytometry against PE-quantitation beads.\n$\\sigma_s = cF/(2\\pi R S_{sol} T)$; for a bead that is not index-matched, apply the measured bead-optics factor [[cite:wang2002]] [[cite:pannu2001]].', { key: 'd11', label: 'Decision', col: 1, struct: 'decision' }),
          FIG('setup_axr', { key: 'axr', label: 'The AX R set-up', col: 2 }),
        ], },
        { name: 'Interactive: the strategy explorer', color: '#6250d6', items: [
          { kind: 'html', key: 'sim', media: 'sim_strategy', label: 'Strategy explorer', col: 'full', w: 1460, h: 900 },
          T('Part D of the report as something to play with: plate timing against the post-wash rate, settling, the photon budget and per-well precision, the LOD with non-specific binding, the four read modes side by side, and saturation and bleaching against power. It reproduces the report’s LOD table, plate times, wash losses and timing tolerances. Press **Recommended** to load the default strategy.', { key: 'simnote', label: 'About the explorer', col: 0 }),
        ] },
        { name: 'Plate and timing', items: [
          FIG('setup_plate', { key: 'plate', label: 'Plate and timing', span: [0, 1] }),
          T('**Per well** (one field, 3–5 s for the stage and Perfect Focus): 12–15 s at 2 µs dwell, 8–10 s at 1 µs.\n• a whole 96-well plate: 19–24 min (2 µs), 13–16 min (1 µs)\n• one column of 8: 1.6–2 min\n• at Λ = 8.6 × 10⁻⁴ s⁻¹, one wash for the plate spreads the PE loss over 63–71 %; staggering by column brings it to ±4–5 % within a column\n• for a 2 % bias the timing must hold to 23 s at that rate, 200 s at 10⁻⁴ s⁻¹\n\nMeasure Λ first (Experiment 11).', { key: 'timing', label: 'Timing', col: 2 }),
        ] },
        { name: 'Precision and the limit of detection', items: [
          T('**Per bead** at 2 µW, 20x (3 SD of a blank bead): ≈65 PE washed; 91, 214 and 649 PE at 0.1, 1 and 10 nM free PE-antibody. Averaging 100 beads brings each ≈10× lower per well. In the reference case (≈500 PE per bead per pM after 1 h) that is ≲ 0.05 pM.\n\n**With non-specific binding** (mean $N_{SD}$ PE per bead, well-to-well CV $c_{well}$):\n$$\\mathrm{LOD}_{well}\\approx3\\sqrt{\\frac{SD_{bead}^2}{n}+(c_{well}N_{SD})^2}$$\nExample: 1,000 PE per bead at 10 % between wells gives ≈300 PE per bead, ≈0.6 pM, 10–50× the optical limit. **Non-specific binding, not optics, sets the LOD** (Experiment 9).', { key: 'lod', label: 'Precision', col: 0 }),
          { kind: 'eq', key: 'eq_lod', label: 'Per-well LOD with non-specific binding', tex: 'L=3\\sqrt{\\frac{s^2}{n}+c^2N^2}', vars: { L: ['per-well LOD', 'PE per bead'], s: ['SD of one blank bead', 'PE per bead'], n: ['beads per well', ''], c: ['well-to-well CV of the non-specific signal', ''], N: ['mean non-specific PE per bead', ''] }, col: 1, w: 430 },
          { kind: 'calc', key: 'calc', label: 'LOD', col: 1, w: 430 },
        ] },
        { name: 'What would change the strategy', color: '#eda100', items: [
          T('• **The bead bends light** (Experiment 5): focus at the measured flat point, not the equator, and calibrate the bead-optics factor before reporting absolute PE.\n• **PE leaves fast after the wash** (Experiment 11): stagger the wash by column, or read without a wash.\n• **Non-specific binding is high** (Experiment 9): lower the detection antibody toward 1 × K₂, add wells per condition, and report the per-well LOD.\n• **PE goes sublinear early** (Experiment 7): lower the power and lengthen the dwell or average frames at the same dose.\n• **10x at a large pinhole matches the 20x per minute** (Experiment 13): switch the routine read to 10x for its fourfold field.\n• **The hook sits within 10× of the sample range** (Experiment 12): move to a two-step format.', { key: 't', label: 'Triggers', col: 0, w: 1100, span: [0, 1] }),
        ] },
      ] },

    /* ======================================================== set-up: AX R */
    { key: 'setupaxr', type: 'note', themeId: 't_pebead_strat', title: 'Set-up: the AX R for PE beads', tags: ['pe-bead', 'set-up', 'AX R'],
      synthesis: 'How the AX R is set up for a PE-bead read: the light path, the session checklist, the four candidate modes, and what to record with every acquisition.',
      sections: [
        { name: 'Light path and settings', items: [FIG('setup_axr', { key: 'fig', label: 'The AX R set-up', col: 'full', w: 1200 })] },
        { name: 'Every session', color: '#1baf7a', items: [
          T('☐ Stand and lasers on 2–3 h before quantitative work (focus drifts ≈0.5 µm per 5 min, power 10–25 % over 3 h when cold) [[cite:jonkman2020]]\n☐ Power at the sample measured with the meter (Experiment 1)\n☐ Flat field for each objective and scan format (Experiment 3)\n☐ The same emission band, HV and offset as the plate’s protocol\n☐ Bit depth noted; no saturated pixels on the top standard\n☐ Transmitted-light channel on with every PE frame\n☐ Reference well imaged at the start and at the end\n☐ Room temperature logged\n☐ Files saved as .nd2, outside the website repo', { key: 'check', label: 'Checklist', col: 0 }),
          T('**Never** focus or search in PE. **Never** change HV within a plate. **Never** set power in % laser. **Never** export 8-bit or LUT-applied images for analysis [[cite:waters2009]] [[cite:quarep2021]].', { key: 'never', label: 'Rules', col: 1 }),
        ] },
        { name: 'The four candidate modes', items: [
          T('**A · 20x/0.80, 1 AU (default).** 0.43 µm pixels at 2048² zoom 1 (≈18.5 px per bead); 0.88 mm field, ≈240 beads at 10⁴ per well; section 2.3 µm; 1–2 µW; 8.4 s per frame at 2 µs.\n\n**B · 20x, 2 AU (comparison).** Section ≈4.6–5.3 µm, about as thick as the bead: the least focus-tolerant 20x mode.\n\n**C · 10x/0.45, 1 AU.** 0.86 µm pixels at 2048² zoom 1 (≈9 px per bead; 4096² for 0.43 µm); 1.77 mm field, ≈950 beads; section 7.1 µm; up to 6–7 µW.\n\n**D · 10x, largest pinhole (3–4 AU, if NIS-Elements allows).** Section ≥ 20 µm: the whole bead sits in the flat top of the response; F within 2 % over ±4.5 µm. Best for throughput; worst for a no-wash read.\n\nPixel size p = 17.7 mm / (M · zoom · N). Galvano frame time ≈ N² × dwell plus flyback.', { key: 'modes', label: 'Modes', col: 0, w: 1100, span: [0, 1] }),
        ] },
        { name: 'What to record', items: [
          T('With every acquisition: date and time; objective and NA; pinhole (AU and µm); laser line and µW at the sample; HV, offset, gain and bit depth; dwell, pixel size, frame size and averaging; emission band; Perfect Focus offset; time since the wash; plate and well; temperature; file name.', { key: 'rec', label: 'Record', col: 0 }),
          T('**Hand back per bead** (one CSV per plate): plate, well, field, bead id, x, y, radius from transmitted light, F (DN), background per pixel, ring mean, rim peak, focus flag, time since wash. Plus the session log above. The model is refit from this file (see [[note:validation|Validating the model]]).', { key: 'csv', label: 'Data back', col: 1 }),
        ] },
      ] },

    /* ======================================================== set-up: beads and plate */
    { key: 'setupassay', type: 'note', themeId: 't_pebead_valid', title: 'Set-up: beads, plate and assay', tags: ['pe-bead', 'set-up', 'assay'],
      synthesis: 'The bead assay as the model assumes it: one-step incubation, fixed beads per volume, a detection-antibody level near K₂, a glass-bottom plate, a plate spin, and a fixed delay from wash to image.',
      sections: [
        { name: 'The assay', items: [
          T('**One step.** Beads, analyte and PE-detection antibody go into the well together and are mixed continuously for a fixed time at a fixed temperature. Then a fixed wash (or none), a 1 min plate spin to settle the beads onto the glass, and imaging at a fixed delay.\n\n**What the model needs fixed:** beads per volume (counted, ≤ 5 % CV), the incubation time, mixing and temperature, the detection-antibody level, and the delay from wash to image. Each is logged per well.', { key: 'what', label: 'Assay', col: 0 }),
          FIG('setup_assay', { key: 'fig', label: 'One-step sandwich', col: 1 }),
        ] },
        { name: 'Reagents and amounts', items: [
          T('• **Capture beads:** 8 µm, ≈10⁶ capture antibodies each (vendor CoA). Ask for the **material, density and refractive index**: polystyrene, PMMA, silica or magnetic changes the optics and the settling.\n• **Beads per well:** 10⁴ in 50 µL (counted). Bead number is a calibration parameter when the beads deplete the analyte.\n• **PE-detection antibody:** 1–2 × K₂ (≈2–4 nM if K₂ ≈ 2 nM); know its PE : IgG ratio (A565/A280, Experiment 10).\n• **Incubation:** 1 h (or 3 h, which roughly doubles the signal), continuous mixing, fixed temperature.\n• **Imaging plate:** glass-bottom 96-well, #1.5H.\n• **Settling:** 1 min at 100–300 g.\n• **Antifade (optional):** n-propyl gallate slows bleaching 1.7×; check it does not disturb binding.', { key: 'reag', label: 'Reagents', col: 0 }),
          T('**Before the first plate:** capture-only beads (no PE) for autofluorescence; beads + PE-antibody without analyte for non-specific binding; buffer + PE-antibody for the solution background. All three are in Experiment 9.', { key: 'controls', label: 'Controls', col: 1 }),
        ] },
        { name: 'Standard-curve plate', items: [
          FIG('setup_plate', { key: 'plate', label: 'Plate and timing', span: [0, 1] }),
        ] },
      ] },

    /* ======================================================== validation */
    { key: 'validation', type: 'planning', themeId: 't_pebead_valid', title: 'Validating the model: experimental approach', tags: ['pe-bead', 'validation'],
      synthesis: 'Each experiment pins one part of the model and sets one protocol choice. The predictions are written down before anything is measured, so every result either confirms the model or names the number to change.',
      sections: [
        { name: 'The approach', items: [
          T('**Bottom up, in five layers.** Instrument (power, detector, flat field) → optics of the shell (section, focus response, sampling) → PE on this instrument (bleaching, saturation, gain) → backgrounds and the assay (non-specific binding, absolute PE, rate constants, standard curve) → strategy (the read modes head to head). Each layer leans on the ones below it, so the order matters: a focus curve means nothing before the power and the detector are known.\n\n' +
            '**Predict, then measure.** Every experiment states the model’s number and a pass range before it runs (below). A pass fixes a protocol setting. A fail names the parameter to change in `params.py`, and the figures, simulators and strategy are regenerated from it.\n\n' +
            '**Paired and blind where it can be.** The same beads across conditions (sampling, power, modes); randomised well order; the reference well at the start and end of each session; standards interleaved with samples.', { key: 'how', label: 'Approach', col: 0 }),
          T('**Ground rules for every session:** warm up 2–3 h; measure µW at the sample; record transmitted light with every PE frame; never focus in PE; one HV and offset per session; no saturated pixels; raw .nd2 outside the repo; log temperature and time since the wash.', { key: 'rules', label: 'Ground rules', col: 0 }),
          FIG('setup_validation', { key: 'map', label: 'Validation map', col: 1 }),
        ] },
        { name: 'Predictions under test', color: '#1baf7a', items: [
          T('Power at the sample is a fixed fraction of the software setting, stable within 3 % over a session.\nPass: linear in % (R² > 0.99) and < 3 % drift over 2 h after warm-up.', { key: 'p1', label: 'Prediction · Exp 01', col: 0, struct: 'claim' }),
          T('The detector is linear to ≈600 photoelectrons per pixel in 2 µs, and F in photoelectrons does not depend on HV.\nPass: a straight photon-transfer line; F/g constant within 2 % across HV.', { key: 'p2', label: 'Prediction · Exp 02, 08', col: 0, struct: 'claim' }),
          T('The plane-integrated section at 1 AU is 2.3–2.6 µm (20x) and 7.1 µm (10x), with tails falling as 1/z².\nPass: within 15 % of the model; the glass-to-solution edge scan fixes the tails and T.', { key: 'p3', label: 'Prediction · Exp 04', col: 0, struct: 'claim' }),
          T('For an index-matched bead F is flat within 2 % over ±1.2 µm at 20x, 1 AU, and symmetric about the equator.\nA lopsided curve means the bead bends light; then the routine plane is wherever F is flat.', { key: 'p4', label: 'Prediction · Exp 05', col: 0, struct: 'claim' }),
          T('F changes < 1.5 % with the bead’s position on the pixel grid at ≥ 12 px per bead, while the rim peak changes 14–39 %.\nPass: paired beads, CV of F across samplings < 2 %.', { key: 'p5', label: 'Prediction · Exp 06', col: 0, struct: 'claim' }),
          T('Bleaching is 0.05–0.06 % per frame at 2 µW, 2 µs, 0.43 µm pixels, and F is within 5 % of linear below ≈5 µW.\nThe bleaching rate gives φ_d on our beads; the power ladder gives the real threshold, dark state included.', { key: 'p6', label: 'Prediction · Exp 07', col: 1, struct: 'claim' }),
          T('Free PE-antibody adds 1.8–2.65 PE/µm² per nM at 20x/0.80, and non-specific binding sets the LOD.\nMeasure the non-specific mean and its well-to-well CV at 0.5, 1, 2 and 5 × K₂.', { key: 'p7', label: 'Prediction · Exp 09', col: 1, struct: 'claim' }),
          T('Two routes to PE per bead agree within 15 %: a solution-PE reference with the measured T, and flow cytometry against PE-quantitation beads.', { key: 'p8', label: 'Prediction · Exp 10', col: 1, struct: 'claim' }),
          T('After the wash PE falls as one exponential, with Λ between 10⁻⁴ and 8.6 × 10⁻⁴ s⁻¹.\nΛ sets the wash plan; a relabel or a clamp separates k₋₂ from k₋₃.', { key: 'p9', label: 'Prediction · Exp 11', col: 1, struct: 'claim' }),
          T('The standard curve peaks near the detection-antibody level and hooks beyond max(S_T + K₁, D_T + K₂); 1× and 10× dilutions agree below the hook.\nFit the mechanistic model globally across the three antibody levels.', { key: 'p10', label: 'Prediction · Exp 12', col: 1, struct: 'claim' }),
          T('20x at 1 AU gives the lowest CV per bead per minute of acquisition; 10x at a large pinhole is faster per bead but noisier at low PE.\nCompare the four modes on the same wells, with flow cytometry as the reference.', { key: 'p11', label: 'Prediction · Exp 13', col: 1, struct: 'claim' }),
        ] },
        { name: 'Run order', color: '#eda100', items: [
          T('**If there is only one day:**\n1. Exp 01 — power at the sample\n2. Exp 02 — photon transfer\n3. Exp 05 — one bead z-series at 20x and 10x, 1 AU, with transmitted light (answers the bead-optics question)\n4. Exp 04 — the glass-to-solution edge scan (answers w(z) and T)\n5. Exp 11 — a post-wash time course at 0, 5, 15, 30 and 60 min (answers Λ)\n\n**The full plan** (6–8 sessions): instrument calibration (Exp 01–03, half a day, short versions every session) → optics of the shell (Exp 04–06, one session) → PE on this instrument (Exp 07–08, one session) → backgrounds and calibration (Exp 09–10, one session) → kinetics and the standard curve (Exp 11–12, two to three sessions) → the head-to-head (Exp 13, one session).', { key: 'order', label: 'Run order', col: 0 }),
          T('**When the data come back.** Send the per-bead CSV and the session log (see [[note:setupaxr|the AX R set-up]]). The fits go into `Research/bead_confocal_sim/params.py`: w(z) and T, the bead-optics factor c(z), φ_d and the saturation threshold, the detector conversion, Λ and the binding constants, the non-specific background. Then rerun `run_figures.py`, the two check scripts and the page build, and update [[note:strategy|the strategy]] where a decision changed. Each milestone of the aim on this theme is checked off with the experiment note that met it.', { key: 'back', label: 'Data back', col: 1 }),
        ] },
        { name: 'The 13 protocols', color: '#6250d6', items:
          Array.from({ length: 13 }, (_, i) => ({ kind: 'noteref', key: 'x' + (i + 1), note: 'exp' + String(i + 1).padStart(2, '0'), col: i % 2, w: 560 })) },
      ] },

    ...EXPNOTES,
  ].map((n, i) => Object.assign(n, { id: 'd_pb' + String(i).padStart(2, '0') + n.key })),   // ids sort in reading order (Scientia lists a project's notes by id)
  wires: [],
};

/* questions and predictions → the experiment that answers them (wires across notes; they show on the Portfolio map) */
const W = module.exports.wires;
[['q1', 5], ['q2', 4], ['q3', 11], ['q4', 9], ['q5', 7], ['q6', 4], ['q7', 10]].forEach(([q, n]) => W.push({ from: 'overview:' + q, to: ex(n), rel: 'needs' }));
[['p1', 1], ['p2', 2], ['p2', 8], ['p3', 4], ['p4', 5], ['p5', 6], ['p6', 7], ['p7', 9], ['p8', 10], ['p9', 11], ['p10', 12], ['p11', 13]].forEach(([p, n]) => W.push({ from: 'validation:' + p, to: ex(n), rel: 'c:tested by' }));
[['c1', 5], ['c4', 11], ['c5', 9], ['c6', 5], ['c7', 7]].forEach(([c, n]) => W.push({ from: 'overview:' + c, to: ex(n), rel: 'c:tested by' }));
W.push({ from: 'imagemodel:barrier', to: ex(5), rel: 'needs' });
/* equations → their calculator */
for (const [note, eqs] of [['binding', ['eq_kd', 'eq_da', 'eq_ceil', 'eq_kapp', 'eq_half']], ['imagemodel', ['eq_I0', 'eq_dose']], ['strategy', ['eq_lod']]])
  for (const e of eqs) W.push({ from: note + ':' + e, to: note + ':calc', rel: 'related', directed: false });
