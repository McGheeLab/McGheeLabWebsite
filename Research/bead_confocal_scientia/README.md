# The PE-bead assay as a Scientia project

This folder is the content of the Scientia project **PE bead assay on the AX R confocal** (`p_pebeadaxr0`), built by
[`scripts/scientia-project/build-project.js`](../../scripts/scientia-project/README.md) and published to Alex's hub
(V3.893). Open it in the Lab Notebook → Scientia → Portfolio. Its literature review is in the **Lit reviews** tab.

## What is in the project

| Note | Type | Theme | What it holds |
|---|---|---|---|
| Overview | note | (project-wide) | The question, the claims so far, the open questions (each wired to the experiment that answers it), the validation map, and links to every note. |
| Binding model | analysis | Binding model | Species and reactions, the mass-action equations with transport, results as claims, equation blocks wired to a calculator, `fig1`, the **binding simulator**, the reference parameters, and the review's findings on the wash. |
| Image model | analysis | Image formation | Shell versus filled bead, the hat-box result, the PSF and two section widths, the photon budget and saturation, bead optics (a barrier), the **confocal simulator**, backgrounds, and `fig5`, `fig7`, `fig9` and the section diagram. |
| Simulation results | analysis | Image formation | Every AX R setting at the 2 µW operating point, `fig2`–`fig9`, and the settings summary. |
| Measurement strategy | planning | Measurement strategy | The recommended read as 11 decisions, the **strategy explorer**, the plate and timing, precision and the LOD (with an equation and a calculator), and what would change the strategy. |
| Set-up: the AX R | note | Measurement strategy | The light path, the session checklist, the four candidate modes, and what to record and hand back. |
| Set-up: beads, plate and assay | note | Validation | The assay, reagents and amounts, the controls, and the plate diagram. |
| Validating the model | planning | Validation | The approach (five layers, predict then measure), 11 predictions wired to their experiments, the run order and one-day path, how data come back, and links to the 13 protocols. |
| Exp 01 – Exp 13 | protocol | (project-wide) | One per experiment, following Gabe's protocol template: purpose and prediction, materials, cautions, a **registered protocol** of the procedure steps, settings, calculator values, analysis, decision and record. Exp 12 includes its 96-well plate. |
| *PE bead assay model — lit review* | literature | Lit reviews tab | 27 papers (16 PDFs on the canvas), 60 located quotes, four lanes; built by `scripts/litreview` (data in `~/Documents/GitHub/LitReviews/pe-bead-confocal/`). |

Each theme has an aim with weighted milestones; check them off as the experiments come in.

## Files

| File | What |
|---|---|
| `project-spec.js` | The content. Edit this, then rebuild. |
| `protocols-to-scientia.cjs` → `protocols.json` | The 13 RM protocol imports turned into note content. Every `[!var:]` value is computed at the calculator defaults, exactly as RM does. |
| `library.json` | Citation keys → lab-library ids (a copy of the review's `libids.json`, which the build prefers when present). |
| `heights.json` | Box heights measured on a desktop render, used for the final layout. |
| `render-check.mjs` | The render check: measures boxes, flags overlaps and missing embeds, and takes screenshots. |

## Rebuild

```bash
REPO=~/Documents/GitHub/McGheeLabWebsite; cd $REPO
# after make_protocols.py changes (needs mathjs 12, as validate.cjs does)
MATHJS=<scratch>/node_modules/mathjs node Research/bead_confocal_scientia/protocols-to-scientia.cjs
# after a simulator change: figures, diagrams, pages
python3 Research/bead_confocal_sim/run_figures.py && python3 Research/bead_confocal_sim/tables.py
node ~/.claude/skills/browser-automation/browser.mjs about:blank --script Research/bead_confocal_sim/diagrams/render.mjs
python3 Research/bead_confocal_sim/interactive/build.py
python3 Research/bead_confocal_sim/interactive/tools/check_confocal.py && python3 Research/bead_confocal_sim/interactive/tools/check_binding.py
# the records (offline)
node scripts/scientia-project/build-project.js Research/bead_confocal_scientia/project-spec.js --heights Research/bead_confocal_scientia/heights.json --out /tmp/pebead-records.json
```

**Render check.**
1. Start a scratch desktop notebook: `SIS_NOBROWSER=1 SIS_PORT=<free> SIS_CONFIG=<scratch>/config.json python3 -I scientia/serve.py`, then POST `api/notebook` with a scratch folder.
2. Open `scientia.html` in a persistent browser session first, because a fresh browser's first sync replaces the server's record.
3. Push with `--local http://127.0.0.1:<port>`.
4. Run `render-check.mjs` in the same session, with `OUT` set to a scratch folder that has a `shots/` subfolder.
5. If boxes moved, copy the new `heights.json` here and rebuild.

## Publish (writes to Alex's hub; run when he asks)

```bash
export NODE_OPTIONS=--network-family-autoselection-attempt-timeout=3000
HUB=uAicelwQ5gNQdH1Qc8wqZcJDRZQ2
# 1. the review's papers → the lab library (once; the citation chips point at these ids)
(cd ~/Documents/GitHub/LitReviews/pe-bead-confocal/build && node $REPO/scripts/litreview/rm-library-add.js spec.json --by mcgheealex@gmail.com --out libids.json --manifest library-manifest.json --commit)
# 2. the project (dry run first)
node scripts/scientia-project/build-project.js Research/bead_confocal_scientia/project-spec.js --heights Research/bead_confocal_scientia/heights.json --out /tmp/pebead-records.json --cloud $HUB
node scripts/scientia-project/build-project.js Research/bead_confocal_scientia/project-spec.js --heights Research/bead_confocal_scientia/heights.json --out /tmp/pebead-records.json --cloud $HUB --commit
# 3. the literature review note, linked to the project (dry run first)
(cd ~/Documents/GitHub/LitReviews/pe-bead-confocal/build && node $REPO/scripts/litreview/build-note.js spec.json quotes.json libids.json --heights boxes2.json --projects p_pebeadaxr0 --out records-final.json --cloud $HUB --commit)
```

Re-running any step is safe: ids and timestamps are fixed, so a re-run updates in place and removes only records of this project that the spec no longer has. **Undo:**
- **The project:** delete it in Scientia, or push delete ops for the ids in the records file.
- **The library:** `library-manifest.json` lists what step 1 created.
