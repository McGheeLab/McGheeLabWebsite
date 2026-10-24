# PE bead experiments as RM protocols

The 13 characterization experiments in [../PE_bead_confocal_experiments.md](../PE_bead_confocal_experiments.md), each as an
importable protocol for the RM Protocols Builder. Every protocol has the purpose (what it pins), the model's prediction, materials,
acquisition settings, live calculators for the numbers you would otherwise work out by hand, the procedure, the analysis, the
decision it feeds and what to record. They follow revision 2 of [../PE_bead_confocal_assay_model.md](../PE_bead_confocal_assay_model.md).

## Import

1. Open `mcgheelab.com/rm/pages/protocols.html` and click **Import protocol**.
2. Drop in one `.protocol-import.json`. The slug is filled in (`pe-ax-01-…` to `pe-ax-13-…`); keep it or change it.
3. Click **Import**. The page then offers to match the materials rows to lab inventory.
4. Open the protocol's **document view** for the calculators. In Exp 09 and Exp 12, press **Add all** in the builder to fill the
   pipetting table and the 96-well plate map.

## The 13 protocols (run in this order)

| File | Experiment | What it is for |
|---|---|---|
| `pe-ax-01-laser-power.protocol-import.json` | Laser power at the sample | Measure 561 nm power at the sample through the 10x and 20x against the NIS laser %, and pick the powers that keep PE linear. |
| `pe-ax-02-photon-transfer.protocol-import.json` | Detector photon-transfer curve | Convert DN to effective photoelectrons for each detector HV with a mean-variance photon-transfer curve, plus offset and read noise. |
| `pe-ax-03-flat-field.protocol-import.json` | Flat field per objective and scan format | Measure the illumination and collection fall-off across the field for each objective, zoom and frame size, every session. |
| `pe-ax-04-psf-plane-axial.protocol-import.json` | PSF, plane response and axial scaling | Measure the point response, the thin-sheet (plane) response H(z) and the dry-to-water focal scaling for each objective and pinhole. |
| `pe-ax-05-bead-z-series.protocol-import.json` | Single-bead z-series in four modes | z-stack assay beads in four objective/pinhole modes to measure how integrated, ring and peak metrics change with focus, and confirm a shell label. |
| `pe-ax-06-sampling-field.protocol-import.json` | Pixels per bead and position in the field | Image the same beads at 8–40 pixels per bead at equal dose, and the same beads at nine positions in the field, to set sampling and the usable field. |
| `pe-ax-07-pe-photophysics.protocol-import.json` | Bleaching, saturation and the dark state | Measure PE bleaching per frame, saturation, the reversible dark state, dwell-versus-averaging and antifade on the beads themselves. |
| `pe-ax-08-gain-ladder.protocol-import.json` | Detector gain ladder on real beads | Image one field of bright and dim beads at six HV settings to confirm that gain only maps signal onto the ADC, and choose the plate HV. |
| `pe-ax-09-backgrounds.protocol-import.json` | Backgrounds and the real detection floor | Measure free PE-antibody background and the bead excluded-volume term, bead autofluorescence, and nonspecific PE binding in each imaging mode. |
| `pe-ax-10-pe-calibration.protocol-import.json` | Absolute calibration to PE per bead | Calibrate intensity to PE molecules per bead with PE quantitation beads, measure PE per detection antibody, and the capture-site distribution. |
| `pe-ax-11-binding-kinetics.protocol-import.json` | Rate constants, settling and depletion | Measure association, post-wash dissociation, delayed detection and a detection-antibody clamp to separate the two off-rates; test settling and bead number. |
| `pe-ax-12-standard-curve.protocol-import.json` | Standard curve and hook | A 12-point half-log analyte titration at three detection-antibody levels in duplicate on one 96-well plate, with reference wells, to fit the model and locate the hook. |
| `pe-ax-13-mode-validation.protocol-import.json` | Head-to-head of the measurement modes | Image one standard-curve plate in four candidate modes, three times in a day and on three days, and score LOD, CV, slope, throughput, bleaching and repeatability. |

If there is only one day: Exp 01 → 02 → 05 → 04 (the glass-to-solution edge, part 4d) → 11 (post-wash time course, part 11b).

## Regenerate and check

The JSON files are generated; edit `make_protocols.py`, never the JSON.

```bash
python3 Research/bead_confocal_protocols/make_protocols.py
npm install --prefix /tmp/mjs mathjs@12        # once; RM loads mathjs 12 from its CDN
MATHJS=/tmp/mjs/node_modules/mathjs node Research/bead_confocal_protocols/validate.cjs
```

`validate.cjs` runs RM's own importer validator (`rm/js/protocol-import.js`), rebuilds the symbol table the way
`rm/js/protocol-formulas.js` does (inputs first, outputs in document order, each rounded to its decimals before the next reads it),
expands every builder as **Add all** would, evaluates every table column and plate cell, checks that every `[!var:…]` token
resolves, and rejects `~` / `^` in prose (RM reads them as sub/superscript) and colour emoji.

## Data back

Keep the `.nd2` files as acquired, in a folder outside this repo, with one plate-map CSV row per well or field (columns in
section 7 of the experiment plan). The simulator in [../bead_confocal_sim/](../bead_confocal_sim/) is then refit to the measured values.
