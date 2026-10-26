# The confocal bead ELISA in Scientia

**Since V3.923 (26 Oct 2026)** the work is **one planning note**, *Confocal bead ELISA: simulations and experimental plan*,
in the theme **Confocal bead ELISA** of the RM project **Source and sink** (`rm-p-source-and-sink`, the project the hub
mirrors from RM). It is built by [`scripts/scientia-project/build-project.js`](../../scripts/scientia-project/README.md)
from [`plan-spec.js`](plan-spec.js). It replaces the V3.893 project *PE bead assay on the AX R confocal* (`p_pebeadaxr0`),
which was deleted from Alex's hub on 26 Oct 2026 while it was shared with Gabe (see *What deleted the old project*).

## The note, top to bottom

| Section | What it holds |
|---|---|
| Start here | How to read the note; its place in Source and sink; status; the question and two open questions (structures on the project page); the literature review card; the assay figure. |
| 1 · What the literature sets | Ten cards, each turning a verdict of the review into a design constraint (wash as an effective rate, beads per well, the hook, the PE power cap, brightness on a bead, the session calibrations, the focus plane, bead optics, MESF calibration, the gaps). Wires come in from the review's own findings and show as links at each card's foot. |
| 2a–2c · Simulations | The three interactive simulators (binding, the confocal image, the plate read), each with what it models, **what it decides** for the experiments, and its figures. |
| 3 · The parameter set | Every setting and assay condition the experiments use, each line marked with its source (sim 2a–2c, review A–D) and the experiment that measures it; the triggers that would change it. |
| Exp 01 – Exp 13 | One section per experiment: purpose and prediction, materials, cautions, the procedure as a protocol **kept in the note** (runnable where it sits), the settings for the run, the numbers, the analysis, and what the result decides. Exp 12 includes its 96-well plate. |
| Run order and data back | The one-day path, the full plan, the session rules, and how results go back into `params.py`, the simulators and section 3. |

The review (*PE bead assay model — lit review*, `d_lr3186c1484a`, 27 papers) is its own note; the build re-links it from
the deleted project to Source and sink by changing only its `review.projectIds`.

## Publish (Alex runs these; they write to his hub)

```bash
cd ~/Documents/GitHub/McGheeLabWebsite
export NODE_OPTIONS=--network-family-autoselection-attempt-timeout=3000
HUB=uAicelwQ5gNQdH1Qc8wqZcJDRZQ2
# 1. the relay fix first (a collaborator's side can no longer delete what you shared)
firebase deploy --only functions:scientiaHub
curl -s https://us-central1-mcgheelab-f56cc.cloudfunctions.net/scientiaHub/      # → "version":"V3.923"
# 2. optional, read only: what deleted the old project, and when
node scripts/scientia-project/hub-deletions.js $HUB --project p_pebeadaxr0 --ids d_pb,c_pb
# 3. the note: dry run, then commit
node scripts/scientia-project/build-project.js Research/bead_confocal_scientia/plan-spec.js --heights Research/bead_confocal_scientia/plan-heights.json --out /tmp/cbe-records.json --cloud $HUB
node scripts/scientia-project/build-project.js Research/bead_confocal_scientia/plan-spec.js --heights Research/bead_confocal_scientia/plan-heights.json --out /tmp/cbe-records.json --cloud $HUB --commit
```

The dry run should report 1 theme, 1 aim, 1 note, 143 components, 6 structures, 20 wires, 14 media; the review re-link
`["p_pebeadaxr0"] → ["rm-p-source-and-sink"]`. The 27 cited papers should already be in the library mirror (Alex added them on 24 Oct); any it lists missing show as "[missing]" chips until they are. Re-running is
safe: ids and timestamps are fixed, so it updates in place and removes only records of this note the spec no longer has
(id tag `cbe`). It never writes the Source and sink project record, and if the hub has no `rm-p-source-and-sink` it
stops with "is not in hub … nothing written" (the id was taken from the hub's test fixtures; give the real one in
`plan-spec.js` → `project.id`). Share it with Gabe again only after step 1.

## What deleted the old project

The V3.899 share relay treated any shared record missing from a collaborator's hub as the collaborator deleting it, and
deleted the owner's original: on a live push (`inbound`) and in the hourly safety pass (`sharePass`, step 1). A desktop
that replaces its cloud hub (scientia-cloud.py's replace, or a first run with `--prefer local`) never had the copies, so
everything shared disappeared from the owner's hub too. The literature review was not part of the shared project, so it
survived. V3.923 lets a collaborator remove only records that came from them (the owner's row last written through their
relay device), never the shared project or review itself, and puts anything else back in their hub. Step 2 above confirms
the device and time from the tombstones.

## Files

| File | What |
|---|---|
| `plan-spec.js` | The note (V3.923). Edit this, then rebuild. |
| `plan-heights.json` | Box heights measured on a desktop render of the note. |
| `protocols-to-scientia.cjs` → `protocols.json` | The 13 RM protocol imports turned into note content; every `[!var:]` value computed at the calculator defaults. |
| `library.json` | Citation keys → lab-library ids (the review's `libids.json` is preferred when present). |
| `render-check.mjs` | Measures boxes, flags overlaps and missing embeds, takes screenshots. |
| `project-spec.js`, `heights.json` | The V3.893 project (21 notes, `p_pebeadaxr0`), kept for its history; it still builds. |

## Rebuild and check

```bash
# after make_protocols.py changes (needs mathjs 12, as validate.cjs does)
MATHJS=<scratch>/node_modules/mathjs node Research/bead_confocal_scientia/protocols-to-scientia.cjs
# after a simulator change: figures, diagrams, pages
python3 Research/bead_confocal_sim/run_figures.py && python3 Research/bead_confocal_sim/tables.py
python3 Research/bead_confocal_sim/interactive/build.py
# the records (offline)
node scripts/scientia-project/build-project.js Research/bead_confocal_scientia/plan-spec.js --heights Research/bead_confocal_scientia/plan-heights.json --out /tmp/cbe-records.json
```

**Render check.** Start a scratch desktop notebook (`SIS_NOBROWSER=1 SIS_PORT=<free> SIS_CONFIG=<scratch>/config.json
python3 -I scientia/serve.py`, then POST `api/notebook` with a scratch folder); open `scientia.html` in a persistent
browser session first (a fresh browser's first sync replaces the server's record); push a stand-in `rm-p-source-and-sink`
project and the review's `records-final.json` (local only); push with `--local http://127.0.0.1:<port>`; run
`OUT=<scratch> RECORDS=/tmp/cbe-records.json node ~/.claude/skills/browser-automation/browser.mjs --session <s> --script
Research/bead_confocal_scientia/render-check.mjs`; copy its `heights.json` to `plan-heights.json` and rebuild. V3.923:
143 boxes, 0 overlaps, 0 missing embeds.
