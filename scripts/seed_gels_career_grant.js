#!/usr/bin/env node
/* seed_gels_career_grant.js
 *
 * V3.717 — one-shot: author the NSF CAREER grant card and its three aim
 * cards on the research map, then clear the legacy grant out of the
 * "GELS energy landscape" concept (which is what puts the amber
 * "grant (unmoved)" chip on that card).
 *
 * Content is transcribed from the submitted package at
 * ~/Documents/GitHub/GELS CAREER/Final package — the Project Summary,
 * the cover letter (solicitation NSF 22-586, CBET/EBBS), and §5.1-5.3 of
 * the project description. Nothing here is invented; the one field left
 * blank on purpose is grant_meta.target_deadline, which the package does
 * not state as a date.
 *
 * Usage:
 *   node scripts/seed_gels_career_grant.js            # dry run, writes nothing
 *   node scripts/seed_gels_career_grant.js --commit   # actually writes
 *
 * Prerequisites: npm install firebase-admin, plus scripts/service-account.json
 * (gitignored) or GOOGLE_APPLICATION_CREDENTIALS.
 *
 * Idempotent: a card whose id already exists is skipped, not overwritten,
 * so a re-run after a partial failure finishes the job. The concept is
 * stripped only AFTER its grant card exists.
 */

const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');

const COMMIT = process.argv.includes('--commit');
const CONCEPT_ID = 'gels-energy-landscape';
const GRANT_ID = 'gels-career';
const DRAFT_ID = 'career-understanding-cell-driven-remodeling-and-self-assembly-of-granular-microgel-scaffolds';
const DRAFT_TITLE = 'CAREER: Understanding Cell-Driven Remodeling and Self-Assembly of Granular Microgel Scaffolds';

/* ── content ──────────────────────────────────────────────────── */

// Mirrors research-composer.js TEMPLATES + compileDescription(), so the
// card opens in the guided editor with every prompt already answered.
const GRANT_TEMPLATE = [
  ['aims_sketch',  'Aims sketch'],
  ['significance', 'Significance'],
  ['innovation',   'Innovation'],
  ['agency_fit',   'Fit'],
];
const AIM_TEMPLATE = [
  ['target_result', 'Target result'],
  ['how_we_know',   'How we’ll know'],
  ['feeds',         'What it feeds'],
  ['risks',         'Risks'],
];

const GRANT_ANSWERS = {
  aims_sketch:
    'Three aims test one hypothesis: a volume of granular microgels encodes a tunable energy landscape — set by microgel size (20–200 µm), shape, single-granule stiffness (0.1–20 kPa), and the ratio of functional to inert granules — that cells collectively navigate as active agents, remodelling only where the net traction stress they generate exceeds the local yield stress of the jammed material.\n\n' +
    'Aim 1 maps how GELS variables define the initial landscape and the emergent tissue architecture, producing a library of active-material bio-inks. Aim 2 adapts traction force microscopy to discrete granular contacts to resolve per-granule cell stress and extract the active-agent rules. Aim 3 couples both datasets into a validated, open-source GELS-DEM simulation that yields dimensionless design rules and locates the compaction-to-architecture transition.',
  significance:
    'Biological tissue self-assembles when cells reorganize the matrix around them, but in compliant materials cellular forces drive that reorganization to a single dead end: a compact spheroid whose diffusion-limited core cannot sustain a functional tissue. The two dominant in-vitro strategies each fail at a different limit — 3D bioprinting is precise but cannot build complex tissue at scale, and self-assembly scales freely but yields non-physiologic architectures.\n\n' +
    'Rational design of transport-capable in vitro tissue addresses an urgent need created by the FDA Modernization Act 2.0 and the limits of current organoid and organ-on-chip models, with direct application to drug screening, disease modeling, and regenerative medicine.',
  innovation:
    'The first mechanics-based framework connecting the particle-scale energy landscape of a granular microgel matrix to the emergent tissue architecture cells produce — bridging granular physics, active-matter biology, and biomaterial design, none of which currently describes this system. Prior work has isolated single variables without connecting them to remodelling outcome.\n\n' +
    'Because the design rules are expressed in the geometry of the landscape rather than the chemistry of any single material, they generalize across granular living-material systems and replace today’s trial-and-error material design. The lab’s GELS platform — contractile fibroblasts rearranging granules into perfusable microchannels rather than collapsing into a spheroid — is the experimental foundation.',
  agency_fit:
    'Submitted to NSF in response to solicitation NSF 22-586 (Faculty Early Career Development, CAREER), requesting assignment to the Engineering Biological and Biomedical Systems (EBBS) program in the Division of Chemical, Bioengineering, Environmental, and Transport Systems (CBET), Directorate for Engineering. Program Director: Dr. Rizia Bardhan.\n\n' +
    'The integrated education plan trains students to work rigorously at the computation–experiment–biology interface through a verify-then-trust pedagogy for critically evaluating AI-generated models: a new graduate course module, an undergraduate fabrication pipeline prioritizing community-college transfer and first-generation students, and annual “Building with Beads” outreach in southern Arizona. All simulation code, datasets, and educational modules are released open-source.',
};

const AIMS = [
  {
    id: 'gels-career-aim-1',
    title: 'Aim 1 — Map the energy landscape to tissue architecture',
    abbr: 'Aim 1',
    one_liner: 'How microgel size, shape, stiffness and functional-to-inert ratio set terminal compaction and transport architecture.',
    answers: {
      target_result:
        'A composition phase diagram with organ-comparison descriptors: a quantitative map from granule properties to the architecture cells build. Terminal architecture is hypothesized to emerge from competition among four factors — cell traction (rising with granule stiffness), inter-granule contact area (set by shape), the landscape’s energy density (set by stiffness, size and inert fraction), and degree of functionalization. Their balance selects spheroid compaction, a stable perfusable architecture, or arrest.\n\n' +
        'Year 1 deliverable: a characterized bio-ink library with per-batch size, shape, stiffness, packing fraction and ratio metadata linked to the emergent architecture.',
      how_we_know:
        'Task 1a — fabricate the library: microfluidics for precise size and shape, batch emulsification with sieve fractionation spanning 20–200 µm; spherical and superellipsoidal geometries; stiffness 0.1–20 kPa set by crosslinker and measured by microindentation. A collagen-functionalized phase (EDC-NHS) presents integrin ligands; an enzymatically degradable agarose phase sets the rearrangeable barrier. Bulk oscillatory and creep rheology give each batch’s yield stress.\n\n' +
        'Task 1b — architecture: confocal timelapse on the Nikon AX-R over 14 days with Cy5-labelled microbeads; descriptors from LOVAMAP (void networks), a cleared-organ vascular panel (length, diameter, tortuosity, connectivity), fractal dimension and lacunarity, and intercapillary distance by Euclidean distance transform — co-registered to matched histology in TissUUmaps for like-for-like comparison.\n\n' +
        'Task 1c — transport: high-molecular-weight fluorescent dextran imaged by confocal timelapse, interstitial flow field by PIV, and Darcy permeability k = −(µLQ)/(A ΔP).',
      feeds:
        'The per-bio-ink descriptor vectors define the Aim 3 validation targets, and the characterized bio-ink library is the substrate Aim 2 measures forces in. The microindentation stiffness measured here is what converts Aim 2’s bead displacements into cellular stress.',
      risks:
        'If microfluidic droplet generation cannot fill the composition space, shift to batch emulsification with size fractionation (serial sieving or differential centrifugation), accepting dispersity for throughput and reserving microfluidics for shape-controlled subsets.\n\n' +
        'If confocal penetration fails in scattering packings, use core-facility two-photon microscopes, add deep-infrared fluorophores (excitation near 760 nm), or optically clear fixed endpoint constructs.\n\n' +
        'If the dextran signal is too sparse or saturating to resolve the flow field, tune molecular weight and concentration to each bio-ink’s channel scale and cross-check permeability against bulk Darcy measurement.',
    },
  },
  {
    id: 'gels-career-aim-2',
    title: 'Aim 2 — Traction force microscopy in active granular media',
    abbr: 'Aim 2',
    one_liner: 'Separate local granule deformation from global packing rearrangement to extract the agent-based rules of cell-driven remodelling.',
    answers: {
      target_result:
        'The agent-based rules governing cell-driven rearrangement, obtained by separating two strains that are superimposed in every granule’s 3D location at once: the local strain a cell imparts to a single granule surface, and the global strain from rearrangement of the packing.\n\n' +
        'The hypothesis under test: a fibroblast rearranges a granule only when its local stress exceeds the packing’s local yield stress — so the two scales together define the balance selecting channel architecture over compaction.',
      how_we_know:
        'Micron-scale fluorescent fiducial beads are distributed throughout every granule, making each its own strain sensor at two scales. At the jammed-system scale the bead constellation reports how each granule rigidly translates and rotates as neighbours rearrange; at the single-granule scale the relative bead motion reports the local surface deformation a cell imparts, converted to cellular stress via the Aim 1 microindentation stiffness.\n\n' +
        'Acquiring both simultaneously maps this balance across the library and characterizes the cell as an active agent — how stiffness sets its migration and force output, how shape sets contact area and bridging. Preliminary recovery of granule strain fields and back-calculated stress anchors feasibility.',
      feeds:
        'Supplies the force and bridging rules that reinforce Aim 3’s active-agent model, and locates the compaction-to-architecture transition that Aim 3 must reproduce.',
      risks:
        'This measurement exceeds conventional TFM methods and analysis tools, which assume a single continuous substrate — separating the two superimposed strains per granule in 3D is the central methodological risk of the aim.',
    },
  },
  {
    id: 'gels-career-aim-3',
    title: 'Aim 3 — A predictive, open-source GELS-DEM framework',
    abbr: 'Aim 3',
    one_liner: 'Couple the Aim 1 and Aim 2 datasets into a validated simulation that yields dimensionless design rules.',
    answers: {
      target_result:
        'A validated coupled cell-granular discrete element method framework that reproduces measured tissue architectural features, locates the compaction-to-architecture transition, and predicts held-out constructs within quantified accuracy — released as an open-source software package.\n\n' +
        'The scientific product is a set of generalizable, dimensionless design rules predicting the emergent construct from an initial bio-ink distribution.',
      how_we_know:
        'Cross-validation against the Aim 1 combinatorial datasets and the Aim 2 force and bridging rules, with accuracy quantified on held-out constructs. Success is measured against the descriptor vectors and permeability curves Aim 1 produces, not against qualitative morphology.',
      feeds:
        'The design rules are the deliverable of the award: expressed in the geometry of the landscape rather than the chemistry of any one material, they transfer across microgel chemistries and cell types, and the released code is the open-source artifact of the project.',
      risks:
        'Active-granular simulations in the literature are validated mostly on 2D robotic swarms (BOBbots, smarticles). Extending this class to a 3D, biologically actuated system — where the active agent is a contractile fibroblast and the packing is imaged directly by confocal microscopy — is the extrapolation the aim rests on, which is why validation runs against two independent experimental aims rather than one.',
    },
  },
];

/* ── helpers ──────────────────────────────────────────────────── */

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
// Byte-for-byte the composer's compileDescription(), so re-compiling in
// the browser produces the same HTML and nothing shifts under the PI.
function compile(template, answers) {
  return template.map(([key, heading]) => {
    const a = (answers[key] || '').trim();
    if (!a) return '';
    const paras = a.split(/\n{2,}/).map(p => '<p>' + esc(p.trim()).replace(/\n/g, '<br>') + '</p>').join('');
    return '<h3>' + esc(heading) + '</h3>' + paras;
  }).filter(Boolean).join('');
}

function initFirestore() {
  const local = path.join(__dirname, 'service-account.json');
  if (fs.existsSync(local)) {
    admin.initializeApp({ credential: admin.credential.cert(require(local)) });
  } else {
    admin.initializeApp({ credential: admin.credential.applicationDefault() });
  }
  return admin.firestore();
}

/* ── run ──────────────────────────────────────────────────────── */

(async () => {
  const db = initFirestore();
  const coll = db.collection('researchFoci');
  const now = new Date().toISOString();

  const conceptSnap = await coll.doc(CONCEPT_ID).get();
  if (!conceptSnap.exists) throw new Error('Concept "' + CONCEPT_ID + '" not found.');
  const concept = conceptSnap.data();
  const author = concept.created_by || null;   // the PI — same hand that owns the concept

  const grantRefs = ((concept.links || {}).draft_refs || []).filter(r => r.kind === 'grant');
  const keptRefs = ((concept.links || {}).draft_refs || []).filter(r => r.kind !== 'grant');

  console.log(COMMIT ? '=== COMMIT ===' : '=== DRY RUN (no writes; pass --commit) ===');
  console.log('Concept  : ' + CONCEPT_ID + ' — "' + (concept.title || '') + '"');
  console.log('  legacy grant refs to remove: ' + JSON.stringify(grantRefs.map(r => r.id)));
  console.log('  grant_meta to clear        : ' + JSON.stringify(concept.grant_meta || null));
  console.log('  other draft_refs kept      : ' + keptRefs.length);

  const stamp = { created_by: author, created_at: now, updated_by: author, updated_at: now, schema_version: 1 };

  const grantDoc = Object.assign({
    level: 'grant',
    title: DRAFT_TITLE,
    abbr: 'GELS CAREER',
    icon: '📑',
    color: concept.color || '',
    one_liner: 'Predictive, mechanism-based design rules for cell-driven remodeling and self-assembly in granular microgel matrices.',
    // "Pending" — submitted, awaiting a decision.
    status: 'submitted',
    status_source: 'manual',
    template_fields: { template_version: 1, answers: GRANT_ANSWERS },
    description_html: compile(GRANT_TEMPLATE, GRANT_ANSWERS),
    grant_meta: {
      agency: 'NSF',
      mechanism: 'CAREER',
      submit_to: 'CBET — Engineering Biological and Biomedical Systems (EBBS), solicitation NSF 22-586',
      submission_url: 'https://www.nsf.gov/pubs/2022/nsf22586/nsf22586.htm',
      // The package states the submission month but no deadline DATE, so
      // this stays the RM "unknown date" sentinel rather than a guess.
      target_deadline: 'TBD',
      scope_html: '',
      promoted_draft_id: null,
      award_number: '',
      period_start: '',
      period_end: '',
    },
    // The card and its builder draft share an identity — but NOT a status:
    // a grant's status is manual, set here (research.js effStatus).
    source_draft_id: DRAFT_ID,
    links: {
      specialty_ids: [], concept_ids: [CONCEPT_ID], grant_ids: [], aim_ids: [], output_ids: [],
      theme_id: (concept.links || {}).theme_id || null,
      draft_refs: grantRefs.length ? grantRefs : [{ id: DRAFT_ID, title: DRAFT_TITLE, kind: 'grant' }],
      patents: [], training_slugs: [],
    },
    member_uids: (concept.member_uids || []).slice(),
    member_roles: Object.assign({}, concept.member_roles || {}),
    media: [], overview_blocks: [], published: false, published_at: null, order: 0,
  }, stamp);

  const aimDocs = AIMS.map((a, i) => Object.assign({
    level: 'aim',
    title: a.title,
    abbr: a.abbr,
    icon: '🎯',
    color: concept.color || '',
    one_liner: a.one_liner,
    status: 'planning',
    status_source: 'manual',
    template_fields: { template_version: 1, answers: a.answers },
    description_html: compile(AIM_TEMPLATE, a.answers),
    grant_meta: null,
    source_draft_id: null,
    links: {
      specialty_ids: [], concept_ids: [], grant_ids: [GRANT_ID], aim_ids: [], output_ids: [],
      theme_id: null, draft_refs: [], patents: [], training_slugs: [],
    },
    member_uids: (concept.member_uids || []).slice(),
    member_roles: Object.assign({}, concept.member_roles || {}),
    media: [], overview_blocks: [], published: false, published_at: null,
    order: (i + 1) * 10,
  }, stamp, { _id: a.id }));

  console.log('\nWould create:');
  console.log('  ' + GRANT_ID.padEnd(22) + ' grant  status=submitted  → concept ' + CONCEPT_ID
    + '  draft=' + DRAFT_ID.slice(0, 24) + '…');
  console.log('    description_html: ' + grantDoc.description_html.length + ' chars, '
    + GRANT_TEMPLATE.length + ' template answers');
  aimDocs.forEach(a => {
    console.log('  ' + a._id.padEnd(22) + ' aim    → grant ' + GRANT_ID + '  "' + a.title + '"');
    console.log('    description_html: ' + a.description_html.length + ' chars, '
      + AIM_TEMPLATE.length + ' template answers');
  });

  if (!COMMIT) { console.log('\nDry run — nothing written. Re-run with --commit.'); process.exit(0); }

  // 1. the grant card
  if ((await coll.doc(GRANT_ID).get()).exists) {
    console.log('\nskip   ' + GRANT_ID + ' (already exists)');
  } else {
    await coll.doc(GRANT_ID).set(grantDoc);
    console.log('\ncreate ' + GRANT_ID);
  }
  // 2. the aims
  for (const a of aimDocs) {
    const id = a._id; const body = Object.assign({}, a); delete body._id;
    if ((await coll.doc(id).get()).exists) { console.log('skip   ' + id + ' (already exists)'); continue; }
    await coll.doc(id).set(body);
    console.log('create ' + id);
  }
  // 3. strip the concept — ONLY once its grant card is confirmed present,
  //    so a failure above can never lose the legacy reference.
  if ((await coll.doc(GRANT_ID).get()).exists) {
    await coll.doc(CONCEPT_ID).update({
      grant_meta: null,
      'links.draft_refs': keptRefs,
      updated_by: author,
      updated_at: new Date().toISOString(),
    });
    console.log('update ' + CONCEPT_ID + ' — grant_meta cleared, ' + grantRefs.length + ' grant ref(s) removed');
  }
  console.log('\nDone.');
  process.exit(0);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
