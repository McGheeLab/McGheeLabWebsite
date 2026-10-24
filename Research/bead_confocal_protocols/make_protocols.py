#!/usr/bin/env python3
"""Generate the 13 PE-bead characterization experiments as RM Protocols Builder imports.

Each experiment in Research/PE_bead_confocal_experiments.md becomes one `<slug>.protocol-import.json`
(format `protocol-import-v1`, see .claude/skills/protocol-import/SKILL.md) that imports on
mcgheelab.com/rm/pages/protocols.html via "Import protocol".

Run:  python3 Research/bead_confocal_protocols/make_protocols.py
Then: node Research/bead_confocal_protocols/validate.mjs   (needs mathjs 12 on NODE_PATH)

Conventions kept for RM's engine (rm/js/protocol-formulas.js):
  * calculator outputs are rounded to `decimals` before later outputs read them, and are evaluated in
    document order, so every output is in a convenient unit and chains only forward;
  * prose never uses "~" or "^" (the inline vocabulary reads them as sub/superscript); use "≈" and "²";
  * no colour emoji (lab rule V3.861); materials rows keep item_ref null (the page-side matcher links them).
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
TOTAL = 13


# ── block helpers ──────────────────────────────────────────────────────────────────────────────────
def doc_header(title, subtitle, chips):
    return {"kind": "docHeader", "body": subtitle,
            "attrs": {"brand": "", "title": title, "chips": [{"text": c} for c in chips]}}


def callout(kind, text):
    return {"kind": "callout", "body": text, "attrs": {"type": kind}}


def heading(code, text):
    return {"kind": "heading", "body": text, "attrs": {"code": code, "rule": True}}


def step(text):
    return {"kind": "step", "body": text}


def table(columns, rows, caption=""):
    cols = []
    for c in columns:
        key, label = c[0], c[1]
        cols.append({"key": key, "label": label, "align": c[2] if len(c) > 2 else "left",
                     "mono": bool(c[3]) if len(c) > 3 else False})
    return {"kind": "table", "body": caption, "attrs": {"columns": cols, "rows": rows}}


def settings(rows, caption="Acquisition settings"):
    return table([("setting", "Setting"), ("value", "Value")],
                 [{"setting": a, "value": b} for a, b in rows], caption)


def record(fields, caption="Record for every acquisition"):
    return table([("field", "Field"), ("note", "What to write")],
                 [{"field": a, "note": b} for a, b in fields], caption)


def kv(items):
    return {"kind": "kv", "attrs": {"items": [{"term": a, "def": b} for a, b in items]}}


def materials(rows):
    out = []
    for r in rows:
        qty, unit, text = r
        out.append({"qty": qty, "unit": unit, "free_text": text, "item_ref": None})
    return {"kind": "materials", "attrs": {"rows": out}}


def inp(name, label, default, unit="", widget="number", lo=None, hi=None, stp=None, hint=""):
    d = {"name": name, "label": label, "widget": widget, "unit": unit, "default": default}
    if lo is not None:
        d["min"] = lo
    if hi is not None:
        d["max"] = hi
    if stp is not None:
        d["step"] = stp
    if hint:
        d["rangeHint"] = hint
    return d


def out(name, label, expr, unit="", decimals=2):
    return {"name": name, "label": label, "expr": expr, "unit": unit, "decimals": decimals}


def calculator(label, inputs, outputs, table_spec=None):
    return {"kind": "calculator", "attrs": {
        "label": label, "inputs": inputs, "outputs": outputs,
        "table": table_spec or {"dataset": "", "columns": []}}}


def timeline(title, marks):
    return {"kind": "timeline", "body": title,
            "attrs": {"marks": [{"at": a, "label": b, "sub": c, "included": True} for a, b, c in marks]}}


def section(label, children):
    return {"label": label, "children": children}


def protocol(num, slug, title, summary, tags, sections):
    return {
        "format": "protocol-import-v1",
        "source": {"kind": "md", "filename": "PE_bead_confocal_experiments.md"},
        "protocol": {
            "id": slug,
            "title": title,
            "summary": summary,
            "category": "imaging",
            "tags": ["pe-beads", "confocal", "ax-r", "characterization", "exp-%02d" % num] + tags,
            "tree": {"meta": {}, "sections": sections},
        },
    }


# shared prose
BEFORE = callout("critical",
    "Before any quantitative acquisition: stand and lasers on for 2–3 h; 561 nm excitation; the same PE emission band "
    "(e.g. 570–620 nm) every time; 16-bit with fine integration (the default is 12-bit, so check the file); one HV "
    "and one offset for the whole session; background mode at least 50 DN above zero; no saturated pixels. Find focus "
    "in transmitted light and hold it with Perfect Focus. Never live-scan PE to focus.")
DATA = callout("note",
    "Save the .nd2 files as acquired (no 8-bit export, no LUT) in a folder outside the website repo, e.g. "
    "BeadConfocalData/<date>_<exp>/, and fill one plate-map CSV row per well or field (columns are listed in "
    "Research/PE_bead_confocal_experiments.md, section 7).")
H_C = "6.626e-34 * 2.998e8"   # J·m


def absorbed_expr(p, dwell, px, eps, lam):
    """Photons absorbed per PE in one full raster frame (linear regime). Units: µW, µs, µm, M⁻¹cm⁻¹, µm."""
    return ("3.82e-21 * {eps} * ({p} * 1e-6 * {d} * 1e-6 / ({px} * 1e-4) ^ 2) * ({lam} * 1e-6 / ({hc}))"
            .format(eps=eps, p=p, d=dwell, px=px, lam=lam, hc=H_C))


PROTOCOLS = []

# ════════════════════════════════════════════════════════════════════════════════════════════════════
# 01 — Laser power at the sample
PROTOCOLS.append(protocol(
    1, "pe-ax-01-laser-power", "PE beads · Exp 01 · Laser power at the sample",
    "Measure 561 nm power at the sample through the 10x and 20x against the NIS laser %, and pick the powers that keep PE linear.",
    ["laser", "power-meter", "calibration"],
    [
        section("Overview", [
            doc_header("Laser power at the sample", "Every later experiment is specified in µW at the sample, never in laser %.",
                       ["Exp 01 of %d" % TOTAL, "≈45 min first time, 5 min per session after", "Instrument block"]),
            callout("note", "Pins: peak irradiance at the focus, and from it the PE excitation rate, the saturation level and the "
                            "bleaching dose per frame. The same laser % gives different power through the 10x and the 20x "
                            "because the back aperture is filled differently, and the %-to-µW map drifts during a session."),
            callout("assume", "Model prediction: emission is ≈10 % below linear (I/Iₛ ≈ 0.1) at ≈3 µW through the 20x and "
                              "≈8 µW through the 10x; Iₛ ≈ 19 kW/cm² for R-PE at 561 nm."),
            callout("timing", "≈45 min first time; 5 min at the start and end of each quantitative session."),
        ]),
        section("Materials", [
            materials([("1", "ea", "Slide-format photodiode power sensor (Thorlabs S170C-type) and console"),
                       ("1", "ea", "Lens tissue"),
                       ("", "", "NIS-Elements with the 561 nm line enabled")]),
        ]),
        section("Settings", [
            settings([("Laser line", "561 nm"),
                      ("Objectives", "10x/0.45 Plan Apo λD, then the 20x (read the NA on the barrel)"),
                      ("Beam", "Stationary spot (point or stimulation mode) if NIS allows; otherwise a 512² scan at maximum zoom, and note that the reading is scan-averaged"),
                      ("Meter wavelength", "561 nm"),
                      ("Laser %", "0.1, 0.3, 1, 3, 10, 30, 100")]),
            BEFORE,
        ]),
        section("Calculator", [
            calculator("Irradiance and PE saturation at the focus", [
                inp("p_uw", "Power at the sample", 3, "µW", "slider", 0.1, 100, 0.1),
                inp("na", "Objective NA", 0.75, ""),
                inp("lam_ex", "Excitation wavelength", 0.561, "µm"),
                inp("i_sat", "PE saturation irradiance", 19, "kW/cm²", hint="≈19 for R-PE at 561 nm"),
                inp("target_s", "Target I/Iₛ", 0.1, "", "slider", 0.02, 0.5, 0.01),
            ], [
                out("w0_um", "Focal spot radius (1/e²)", "0.433 * lam_ex / na", "µm", 3),
                out("i0_kw", "Peak irradiance", "2 * p_uw * 1e-6 / (pi * (w0_um * 1e-4) ^ 2) / 1000", "kW/cm²", 2),
                out("s_ratio", "I/Iₛ", "i0_kw / i_sat", "", 3),
                out("sublin_pct", "Emission below linear", "100 * s_ratio / (1 + s_ratio)", "%", 1),
                out("p_target_uw", "Power for the target I/Iₛ", "target_s * i_sat * 1000 * pi * (w0_um * 1e-4) ^ 2 / 2 / 1e-6", "µW", 2),
            ]),
            callout("note", "With [!var:p_uw] at NA [!var:na] the peak irradiance is [!var:i0_kw] and PE emission is "
                            "[!var:sublin_pct] below linear. The power for I/Iₛ = [!var:target_s] is [!var:p_target_uw]."),
        ]),
        section("Procedure", [
            heading("01", "Set up"),
            step("Switch the 561 nm laser on at least 30 min before measuring, for a stable output."),
            step("With the laser off, zero the meter. Set its wavelength to 561 nm."),
            step("Put the sensor on the stage, centred under the 10x, with its active area at the focus (focus on the sensor surface in transmitted light)."),
            heading("02", "Power ladder"),
            step("Park the beam (stationary spot) or start a 512² scan at maximum zoom. Read µW at each laser %: 0.1, 0.3, 1, 3, 10, 30, 100."),
            step("Read 0 % again at the end, to catch meter drift."),
            step("Swap to the 20x, refocus on the sensor, and repeat the ladder."),
            callout("critical", "A scanned beam is blanked during flyback, so a scanning reading is lower than the on-time "
                                "power. Use a stationary spot when you can, and always note which mode you used."),
            heading("03", "Every quantitative session"),
            step("Read the % you will use (and one higher point) through the objective you will use, at the start and at the end of the session. A change of more than 5 % means the intensities need a drift correction."),
        ]),
        section("Analysis", [
            step("Fit µW = a × (laser %) per objective over the linear part of the ladder; record a and the 20x/10x ratio at the same %."),
            step("Enter the measured µW in the calculator with each objective's NA, and read the % that gives the target I/Iₛ (≈0.1)."),
        ]),
        section("Decision & record", [
            callout("note", "Decision: the laser % that gives the operating power for each objective (≈3 µW through the 20x, "
                            "≈8 µW through the 10x, unless Exp 07 moves them). Record power in µW in every later plate map."),
            record([("Date / time", "Start and end of the session"),
                    ("Objective", "Model and NA from the barrel"),
                    ("Laser %", "Each rung of the ladder"),
                    ("Power", "µW at the sample"),
                    ("Mode", "Stationary spot or scan-averaged"),
                    ("Meter", "Sensor model, wavelength setting")]),
            DATA,
        ]),
    ]))

# ════════════════════════════════════════════════════════════════════════════════════════════════════
# 02 — Photon-transfer curve
PROTOCOLS.append(protocol(
    2, "pe-ax-02-photon-transfer", "PE beads · Exp 02 · Detector photon-transfer curve",
    "Convert DN to effective photoelectrons for each detector HV with a mean-variance photon-transfer curve, plus offset and read noise.",
    ["detector", "gaasp", "photon-transfer", "calibration"],
    [
        section("Overview", [
            doc_header("Detector photon-transfer curve", "Shot-noise SNR, LOD and clipping all need DN converted to photoelectrons.",
                       ["Exp 02 of %d" % TOTAL, "≈1.5 h", "Instrument block"]),
            callout("note", "Pins: g·F (DN per effective photoelectron) at each HV, the offset and the read noise. g and F cannot be "
                            "separated this way; their product is exactly what SNR needs."),
            callout("assume", "Model: variance(DN) = g·F × (mean − offset) + σ²_read; PMT excess-noise factor F ≈ 1.2–1.5."),
        ]),
        section("Materials", [
            materials([("1", "ea", "Uniform fluorescent sample in the PE band: orange fluorescent plastic slide, or ≈10 µM rhodamine B in water in a sealed thin chamber"),
                       ("1", "ea", "#1.5 glass-bottom dish or slide + coverslip")]),
        ]),
        section("Settings", [
            settings([("Objective", "20x, pinhole 1 AU"),
                      ("Laser", "561 nm; 8–10 powers from near zero to ≈80 % of full scale on the brightest pixel"),
                      ("Frames", "Two single frames per power (no averaging), plus 20 dark frames with the laser at 0 %"),
                      ("Frame", "512², 2 µs dwell, focus 20 µm into the dye (or on the slide)"),
                      ("HV", "Repeat the whole ladder at 4–5 HV values covering what you will ever use")]),
            BEFORE,
        ]),
        section("Calculator", [
            calculator("Convert a reading to photoelectrons", [
                inp("slope", "Fitted slope (g·F)", 20, "DN per e⁻"),
                inp("offset_dn", "Offset (mean of dark frames)", 200, "DN"),
                inp("read_dn", "Read noise (SD of dark frames)", 3, "DN"),
                inp("adc_max", "ADC full scale", 65535, "DN", hint="4095 in 12-bit mode"),
                inp("dn_reading", "A pixel reading", 5000, "DN"),
            ], [
                out("e_eff", "Effective photoelectrons", "(dn_reading - offset_dn) / slope", "e⁻", 1),
                out("snr_px", "Pixel SNR", "e_eff / sqrt(e_eff + (read_dn / slope) ^ 2)", "", 1),
                out("e_max", "Photoelectrons before clipping", "(adc_max - offset_dn) / slope", "e⁻", 0),
            ]),
            callout("note", "At this HV a pixel reading [!var:dn_reading] holds [!var:e_eff] (SNR [!var:snr_px]); "
                            "a pixel clips above [!var:e_max]."),
        ]),
        section("Procedure", [
            heading("01", "Dark"),
            step("Laser at 0 %, same HV and offset you will use: take 20 frames. They give the offset (mean) and read noise (SD)."),
            heading("02", "Ladder"),
            step("Laser on. At each of 8–10 powers, take two frames in a row without changing anything."),
            step("Move the stage 50 µm between powers, so bleaching of a dye slide does not bias the ladder."),
            heading("03", "Repeat per HV"),
            step("Repeat steps 01–02 at 4–5 HV values. Keep the offset fixed if NIS allows, or re-measure the dark frames at each HV."),
        ]),
        section("Analysis", [
            step("For each frame pair, in a central 256² ROI: m = mean((I₁ + I₂)/2) − offset, and v = var(I₁ − I₂)/2. Taking the difference removes the illumination pattern."),
            step("Fit v = slope × m + σ²_read over the unsaturated points. The slope is g·F at that HV. Check that R² is above 0.99."),
            step("Tabulate slope against HV. PMT gain is steep (≈ a power of HV), so fit log(slope) against log(HV) to interpolate."),
        ]),
        section("Decision & record", [
            callout("note", "Decision: the HV at which the brightest expected rim pixel stays at or below 60–70 % of full scale "
                            "(confirmed in Exp 08), and the slope used to convert every later image to photoelectrons."),
            record([("HV", "Volts or NIS gain value"), ("Offset", "DN"), ("Read noise", "DN"),
                    ("Slope", "DN per effective e⁻, with R²"), ("Powers", "µW at the sample for each rung")]),
            DATA,
        ]),
    ]))

# ════════════════════════════════════════════════════════════════════════════════════════════════════
# 03 — Flat field
PROTOCOLS.append(protocol(
    3, "pe-ax-03-flat-field", "PE beads · Exp 03 · Flat field per objective and scan format",
    "Measure the illumination and collection fall-off across the field for each objective, zoom and frame size, every session.",
    ["flat-field", "shading", "calibration"],
    [
        section("Overview", [
            doc_header("Flat field", "Bead intensity depends on where the bead sits in the field until this correction is applied.",
                       ["Exp 03 of %d" % TOTAL, "≈20 min per session", "Instrument block"]),
            callout("note", "Pins: the vignetting map v(x, y). Corner-to-centre fall-off of 10 % or more is typical on point-scanning "
                            "confocals, and up to 40–60 % at low zoom has been reported."),
        ]),
        section("Materials", [
            materials([("1", "ea", "The uniform sample from Exp 02 (plastic slide or dye chamber)")]),
        ]),
        section("Settings", [
            settings([("Combinations", "Every objective × zoom × frame size you will use for beads"),
                      ("Pinhole / laser / HV", "Exactly the bead settings"),
                      ("Frames", "8, each after a 50 µm stage move (averages out dust and scratches)")]),
            BEFORE,
        ]),
        section("Calculator", [
            calculator("Field and pixel size", [
                inp("m_obj", "Objective magnification", 10, "×"),
                inp("zoom", "Scan zoom", 1, "×"),
                inp("n_px", "Frame size (pixels per side)", 2048, "px"),
                inp("bead_d", "Bead diameter", 8, "µm"),
            ], [
                out("field_um", "Field side at the sample", "17700 / (m_obj * zoom)", "µm", 0),
                out("px_um", "Pixel size", "field_um / n_px", "µm", 3),
                out("ppb", "Pixels across a bead", "bead_d / px_um", "px", 1),
            ]),
            callout("assume", "Field side assumes the FN 25 field is a square inscribed in a 25 mm circle (17.7 mm at the "
                              "intermediate image). Check it once with a stage micrometer."),
        ]),
        section("Procedure", [
            step("Focus 20 µm into the dye (or onto the slide) by transmitted light; turn Perfect Focus on."),
            step("For each combination, take 8 frames with a 50 µm stage move between them."),
            step("Take 10 dark frames (laser 0 %) with the same settings."),
        ]),
        section("Analysis", [
            step("Median-combine the 8 frames, subtract the dark mean, smooth lightly (Gaussian, 2–3 px) and divide by the mean of the central 10 % of the field. That is the flat field FF(x, y)."),
            step("Corrected image = (raw − offset) / FF. Report the corner-to-centre ratio."),
            step("Mark the region where 1/FF is below 1.25; analyse beads only inside it, or report the residual bias."),
        ]),
        section("Decision & record", [
            callout("note", "Decision: the analysable region per objective and scan format, and the FF image used for every bead image of that session."),
            record([("Combination", "Objective, zoom, frame size"), ("Corner / centre", "Ratio"),
                    ("Analysable radius", "Fraction of the half-diagonal"), ("File", "Name of the saved FF image")]),
            DATA,
        ]),
    ]))

# ════════════════════════════════════════════════════════════════════════════════════════════════════
# 04 — PSF, plane response, axial scaling
PROTOCOLS.append(protocol(
    4, "pe-ax-04-psf-plane-axial", "PE beads · Exp 04 · PSF, plane response and axial scaling",
    "Measure the point response, the thin-sheet (plane) response H(z) and the dry-to-water focal scaling for each objective and pinhole.",
    ["psf", "optical-section", "axial-scaling"],
    [
        section("Overview", [
            doc_header("PSF, plane response and axial scaling", "The integrated bead signal depends on H(z), the response to a thin fluorescent sheet.",
                       ["Exp 04 of %d" % TOTAL, "≈4 h", "Optics block"]),
            callout("note", "Pins: lateral and on-axis axial FWHM against pinhole (4a); the plane response H(z) and its shape (4b); "
                            "the focal scaling factor from stage travel to depth in water (4c)."),
            callout("assume", "Model (simulator): 20x/0.75 at 1 AU gives 0.40 µm lateral, 1.5 µm on-axis and 2.6 µm plane-integrated "
                              "axial FWHM; 10x at 4 AU gives a 28 µm plane response with a flat top. The textbook formula for "
                              "the 20x at 1 AU gives 2.3 µm (n = 1)."),
        ]),
        section("Materials", [
            materials([("10", "µL", "100–200 nm orange/red fluorescent beads, diluted 1:1000 in water (4a)"),
                       ("1", "µg/mL", "PE-detection antibody in PBS, 200 µL per well (4b)"),
                       ("1", "well", "Assay beads at high coverage (4c)"),
                       ("1", "ea", "#1.5 glass-bottom plate or dish"),
                       ("", "", "PBS")]),
        ]),
        section("Settings", [
            table([("part", "Part"), ("obj", "Objective"), ("pinhole", "Pinhole"), ("z", "z range / step"), ("px", "Pixel")], [
                {"part": "4a point", "obj": "20x", "pinhole": "0.5, 1, 2, 4 AU, max", "z": "±6 µm / 0.1 µm", "px": "≤0.1 µm"},
                {"part": "4a point", "obj": "10x", "pinhole": "0.5, 1, 2, 4 AU, max", "z": "±15 µm / 0.25 µm", "px": "≤0.2 µm"},
                {"part": "4b plane", "obj": "20x and 10x", "pinhole": "same series", "z": "±3 × section / 0.1 (20x), 0.25 (10x) µm", "px": "any"},
                {"part": "4c beads", "obj": "20x", "pinhole": "1 AU", "z": "−6 to +6 µm around the equator / 0.2 µm", "px": "0.2 µm"},
            ], "Acquisition grid"),
            BEFORE,
        ]),
        section("Calculator", [
            calculator("Pinhole and optical section", [
                inp("na", "Objective NA", 0.75, ""),
                inp("n_imm", "Immersion index (dry = 1)", 1, ""),
                inp("lam_em", "Emission wavelength", 0.578, "µm"),
                inp("ph_au", "Pinhole", 1, "AU", "slider", 0.25, 6, 0.05),
                inp("r_bead", "Bead radius", 4, "µm"),
                inp("z_scale", "Focal scaling (depth per stage µm)", 1.33, "", hint="replace with the 4c result"),
                inp("z_range", "z range of a stack", 12, "µm"),
                inp("z_step", "z step", 0.1, "µm"),
            ], [
                out("au_um", "1 Airy unit at the sample", "1.22 * lam_em / na", "µm", 2),
                out("ph_um", "Pinhole at the sample", "ph_au * au_um", "µm", 2),
                out("sect_um", "Textbook optical section (PH ≥ 1 AU)", "sqrt((0.88 * lam_em / (n_imm - sqrt(n_imm ^ 2 - na ^ 2))) ^ 2 + (sqrt(2) * n_imm * ph_um / na) ^ 2)", "µm", 2),
                out("equator_nominal", "Stage travel from glass to bead equator", "r_bead / z_scale", "µm", 2),
                out("n_planes", "Planes in the stack", "floor(z_range / z_step) + 1", "", 0),
            ]),
            callout("note", "At NA [!var:na] and [!var:ph_au]: the pinhole is [!var:ph_um] at the sample and the textbook section "
                            "is [!var:sect_um]. The bead equator sits [!var:equator_nominal] of stage travel above the glass."),
        ]),
        section("Procedure", [
            heading("4a", "Point response"),
            step("Dry 10 µL of the diluted sub-resolution beads on the glass, then cover with water."),
            step("For each objective and pinhole in the grid, z-stack ≥10 isolated beads at low power (1 µW at 20x, 3 µW at 10x)."),
            heading("4b", "Plane response H(z)"),
            step("Add 200 µL of PE-antibody at 1 µg/mL to an empty glass-bottom well, wait 30 min at room temperature, wash 3× with PBS, leave PBS on."),
            step("Find the layer at very low power. Then for each objective and pinhole, z-scan through it at the steps in the grid. Use a fresh spot for every scan (the layer bleaches)."),
            heading("4c", "Axial scaling"),
            step("Settle high-coverage assay beads (≥30 min). At 20x and 1 AU, z-stack 10 beads from 6 µm below to 6 µm above the equator, 0.2 µm steps, 0.2 µm pixels."),
        ]),
        section("Analysis", [
            step("4a: fit Gaussians to the lateral and axial profiles of each bead; report median FWHM against pinhole."),
            step("4b: mean intensity of the central field against z is H(z). Report its FWHM and its shape: flat-topped, Gaussian, or with 1/z² tails. Send the H(z) table, because the simulator can use it directly."),
            step("4c: z_scale = (bead diameter in x/y) / (top-to-bottom shell peak distance in nominal z). The peak-to-peak distance does not depend on the PSF. Expect ≈1.33."),
        ]),
        section("Decision & record", [
            callout("note", "Decision: whether the 10x open-pinhole H(z) is flat across ±4 µm (the focus tolerance of the high-throughput "
                            "mode), and the Perfect Focus offset to the bead equator."),
            record([("Objective / pinhole", "AU and µm from NIS"), ("FWHM", "Lateral, axial (4a); plane (4b)"),
                    ("H(z)", "Table of mean intensity against z"), ("z_scale", "4c result, n beads, SD")]),
            DATA,
        ]),
    ]))

# ════════════════════════════════════════════════════════════════════════════════════════════════════
# 05 — Single-bead z-series in four modes
PROTOCOLS.append(protocol(
    5, "pe-ax-05-bead-z-series", "PE beads · Exp 05 · Single-bead z-series in four modes",
    "z-stack assay beads in four objective/pinhole modes to measure how integrated, ring and peak metrics change with focus, and confirm a shell label.",
    ["z-stack", "focus", "shell", "metrics"],
    [
        section("Overview", [
            doc_header("Single-bead z-series", "The core test of the image model: what each metric does as focus moves.",
                       ["Exp 05 of %d" % TOTAL, "≈3 h", "Optics block"]),
            callout("note", "Pins: integrated, ring-mean, rim-peak and ring-radius curves against focal offset in each mode; the "
                            "peak/centre contrast at the equator (shell versus penetrating label, and the PSF tail model); the "
                            "bead radius distribution."),
            table([("mode", "Mode"), ("int", "Integrated within 5 %"), ("ring", "Ring-mean loss at 2 µm"),
                   ("pc", "Peak/centre at equator")], [
                {"mode": "A · 10x, pinhole open (≥4 AU)", "int": "±4.5 µm", "ring": "7 %", "pc": "≈3"},
                {"mode": "B · 20x, 1 AU", "int": "±1.75 µm", "ring": "22 %", "pc": "≈15 (simulator) to >100 (Gaussian section)"},
                {"mode": "C · 20x, 4 AU", "int": "±1.5 µm", "ring": "18 %", "pc": "≈3"},
                {"mode": "D · 10x, 1 AU", "int": "±1.5 µm", "ring": "18 %", "pc": "≈4.5"},
            ], "Model predictions to confirm or reject"),
        ]),
        section("Materials", [
            materials([("1", "well", "Assay beads at high coverage (top standard, washed)"),
                       ("1", "well", "Assay beads at mid coverage (≈10 % of the top signal)"),
                       ("1", "ea", "#1.5 glass-bottom plate"),
                       ("", "", "Imaging buffer (PBS)")]),
        ]),
        section("Settings", [
            settings([("Modes", "A 10x open pinhole · B 20x 1 AU · C 20x 4 AU · D 10x 1 AU"),
                      ("z", "From 8 µm below to 8 µm above the equator; 0.5 µm steps at 20x, 1 µm at 10x"),
                      ("Sampling", "20 pixels per bead (0.4 µm pixels)"),
                      ("Power", "1 µW at the sample (20x), 3 µW (10x)"),
                      ("Dwell / frames", "1 µs, one frame per plane"),
                      ("Bleach check", "Re-acquire the first plane after the stack")]),
            BEFORE,
        ]),
        section("Calculator", [
            calculator("Stack plan and bleaching", [
                inp("z_half", "Half-range of the stack", 8, "µm"),
                inp("z_step", "z step", 0.5, "µm"),
                inp("p_uw", "Power at the sample", 1, "µW", "slider", 0.1, 30, 0.1),
                inp("dwell_us", "Pixel dwell", 1, "µs"),
                inp("px_um", "Pixel size", 0.4, "µm"),
                inp("eps_pe", "PE extinction at 561 nm", 1.96e6, "M⁻¹cm⁻¹"),
                inp("phi_b", "PE photodestruction yield", 1.1e-5, "per absorbed photon"),
                inp("lam_ex", "Excitation wavelength", 0.561, "µm"),
            ], [
                out("n_planes", "Planes", "2 * z_half / z_step + 1", "", 0),
                out("abs_frame", "Photons absorbed per PE per plane", absorbed_expr("p_uw", "dwell_us", "px_um", "eps_pe", "lam_ex"), "", 1),
                out("loss_frame_pct", "PE lost per plane", "100 * (1 - exp(-phi_b * abs_frame))", "%", 4),
                out("loss_stack_pct", "PE lost over the stack", "100 * (1 - exp(-phi_b * abs_frame * n_planes))", "%", 2),
            ]),
            callout("note", "[!var:n_planes] planes at [!var:p_uw] and [!var:dwell_us] remove [!var:loss_stack_pct] of the PE. Keep it below 2 %."),
        ]),
        section("Procedure", [
            step("Settle the beads at least 30 min (or spin the plate briefly)."),
            step("Focus on the beads in transmitted light. Set Perfect Focus to the equator (Exp 04 gives the stage travel)."),
            step("Choose a field with ≥10 beads that are at least 10 µm from any neighbour."),
            step("For each mode, in a fresh field, take the stack. Then re-acquire the first plane."),
            step("Repeat for the mid-coverage well."),
            callout("critical", "Use a fresh field for every mode. Re-imaging a field adds its whole stack dose to the next measurement."),
        ]),
        section("Analysis", [
            step("Convert nominal z to depth with z_scale from Exp 04. The equator is the plane of maximum ring radius."),
            step("Per bead per plane: integrated intensity in a disk of radius R + 2.5 µm minus the local annulus background; ring-mean in a 1 µm annulus at the rim; rim peak; ring radius; centre mean."),
            step("Normalize each curve to its equator value and overlay the four modes. Compare with the table above."),
            step("Peak/centre at the equator in mode B decides the PSF tail model. A flat profile (≈1) means the label penetrates the bead."),
            step("Report the equatorial ring-radius distribution (mean, CV): bead-size spread propagates into the integrated metric."),
        ]),
        section("Decision & record", [
            callout("note", "Decision: the default acquisition mode, and the focus tolerance it actually has on this instrument."),
            record([("Well / coverage", "High or mid"), ("Mode", "A–D, with pinhole µm"), ("Bleach check", "First plane before and after (%)"),
                    ("Beads", "Number analysed per mode")]),
            DATA,
        ]),
    ]))

# ════════════════════════════════════════════════════════════════════════════════════════════════════
# 06 — Sampling and field position
PROTOCOLS.append(protocol(
    6, "pe-ax-06-sampling-field", "PE beads · Exp 06 · Pixels per bead and position in the field",
    "Image the same beads at 8–40 pixels per bead at equal dose, and the same beads at nine positions in the field, to set sampling and the usable field.",
    ["sampling", "nyquist", "field-position", "flat-field"],
    [
        section("Overview", [
            doc_header("Pixels per bead and field position", "Coarse pixels buy field of view; the question is how coarse the integrated metric tolerates.",
                       ["Exp 06 of %d" % TOTAL, "≈2 h", "Optics block"]),
            callout("note", "Pins: the scatter of each metric against sampling and sub-pixel position (6a), and what is left of the "
                            "field-position bias after flat-field correction, i.e. field curvature (6b)."),
            table([("ppb", "Pixels per bead"), ("px", "Pixel"), ("pk", "Rim-peak swing"), ("rm", "Ring-mean swing"), ("int", "Integrated swing")], [
                {"ppb": "8", "px": "1.00 µm", "pk": "29 %", "rm": "34 %", "int": "2.7 %"},
                {"ppb": "12", "px": "0.67 µm", "pk": "8.3 %", "rm": "8.1 %", "int": "1.4 %"},
                {"ppb": "20", "px": "0.40 µm", "pk": "5.2 %", "rm": "4.5 %", "int": "0.13 %"},
                {"ppb": "40", "px": "0.20 µm", "pk": "2.2 %", "rm": "2.7 %", "int": "<0.01 %"},
            ], "Model prediction (20x, 1 AU; swing over sub-pixel offsets)"),
        ]),
        section("Materials", [
            materials([("1", "well", "Assay beads at high coverage, at a density giving ≥50 isolated beads per 20x field"),
                       ("1", "ea", "#1.5 glass-bottom plate")]),
        ]),
        section("Settings", [
            settings([("Mode", "Default mode from Exp 05 (repeat in the other leading mode if time allows)"),
                      ("6a sampling", "8, 12, 20, 40 pixels per bead, dwell from the calculator so the dose per µm² is equal"),
                      ("6b positions", "Centre, 4 edge midpoints, 4 corners of the field"),
                      ("Flat field", "From Exp 03, same session")]),
            BEFORE,
        ]),
        section("Calculator", [
            calculator("Scan geometry and equal-dose dwell", [
                inp("m_obj", "Objective magnification", 20, "×"),
                inp("zoom", "Scan zoom", 1, "×"),
                inp("n_px", "Frame size", 1024, "px"),
                inp("bead_d", "Bead diameter", 8, "µm"),
                inp("dwell_ref", "Reference dwell", 2, "µs"),
                inp("ppb_ref", "Reference pixels per bead", 20, "px"),
            ], [
                out("field_um", "Field side", "17700 / (m_obj * zoom)", "µm", 0),
                out("px_um", "Pixel size", "field_um / n_px", "µm", 3),
                out("ppb", "Pixels per bead", "bead_d / px_um", "px", 1),
                out("dwell_eq", "Dwell for the same dose per µm²", "dwell_ref * (ppb_ref / ppb) ^ 2", "µs", 2),
                out("frame_s", "Frame time", "n_px ^ 2 * dwell_eq * 1e-6", "s", 1),
            ]),
            callout("note", "At [!var:ppb] pixels per bead use [!var:dwell_eq] (frame [!var:frame_s]). The AX R offers discrete scan "
                            "speeds: pick the nearest, record the real dwell, and correct by dose in the analysis."),
        ]),
        section("Procedure", [
            heading("6a", "Sampling at equal dose"),
            step("Pick one field. Image it at 8, 12, 20 and 40 pixels per bead (zoom about the same centre), each at the equal-dose dwell, in random order."),
            step("Beads land at random sub-pixel positions, so every phase is sampled without any extra work."),
            heading("6b", "Field position"),
            step("Pick 5 isolated beads. For each, move the stage so the bead sits at the centre, at the 4 edge midpoints and at the 4 corners, imaging each time with the same settings."),
        ]),
        section("Analysis", [
            step("6a: for each bead, every metric at each sampling divided by its 40 px value (paired). Report the SD across beads per sampling, which is the sub-pixel scatter."),
            step("6b: flat-field correct, then plot each metric against distance from the field centre. What remains is field curvature plus any residual shading."),
        ]),
        section("Decision & record", [
            callout("note", "Decision: the coarsest sampling that keeps the integrated-metric scatter below 1 % (the throughput lever), and the usable field radius."),
            record([("Sampling", "Pixels per bead, real dwell"), ("Bead id", "Same id across samplings / positions"),
                    ("Position", "Field coordinates of the bead")]),
            DATA,
        ]),
    ]))

# ════════════════════════════════════════════════════════════════════════════════════════════════════
# 07 — Photophysics
PROTOCOLS.append(protocol(
    7, "pe-ax-07-pe-photophysics", "PE beads · Exp 07 · Bleaching, saturation and the dark state",
    "Measure PE bleaching per frame, saturation, the reversible dark state, dwell-versus-averaging and antifade on the beads themselves.",
    ["photobleaching", "saturation", "dark-state", "antifade"],
    [
        section("Overview", [
            doc_header("PE photophysics on the beads", "Sets the operating power and the scan mode.",
                       ["Exp 07 of %d" % TOTAL, "≈4 h", "Photophysics block"]),
            callout("note", "Pins: bleaching per frame against dose and the photodestruction yield on beads (7a), the reversible "
                            "dark state (7b), the saturation irradiance (7c), signal per dose by scan mode (7d), antifade (7e) and "
                            "the cost of focusing on PE (7f)."),
            callout("assume", "Literature: R-PE photodestruction yield 1.1 × 10⁻⁵ per absorbed photon, 1.7× better with n-propyl gallate; "
                              "ROS scavengers, ascorbate, DTT and oxygen removal did not help. Model: 0.29 % lost per frame at 10 µW, "
                              "2 µs, 0.4 µm pixels at 20x."),
        ]),
        section("Materials", [
            materials([("4", "well", "Assay beads at high coverage (fresh fields for every condition)"),
                       ("1", "well", "Same beads in imaging buffer with n-propyl gallate (7e)"),
                       ("1", "ea", "#1.5 glass-bottom plate")]),
        ]),
        section("Settings", [
            table([("part", "Part"), ("what", "Acquisition")], [
                {"part": "7a", "what": "50 consecutive frames per power, fresh field each; 2 µs; 20 px per bead. 20x: 0.3, 1, 3, 10, 30 µW. 10x: 1, 3, 10, 30, 100 µW"},
                {"part": "7b", "what": "In two 7a fields: pause 60 s after frame 25, then continue"},
                {"part": "7c", "what": "First frame only, 6 powers, fresh field each"},
                {"part": "7d", "what": "Equal dose three ways: 1 frame at 8 µs; 4 averaged frames at 2 µs; resonant with line integration to match"},
                {"part": "7e", "what": "7a at one power, with and without n-propyl gallate"},
                {"part": "7f", "what": "Live-scan one field for 10 s as if focusing, then acquire it and an untouched neighbour"},
            ], "Acquisition plan"),
            BEFORE,
        ]),
        section("Calculator", [
            calculator("Dose, saturation and bleaching", [
                inp("p_uw", "Power at the sample", 10, "µW", "slider", 0.1, 100, 0.1),
                inp("na", "Objective NA", 0.75, ""),
                inp("dwell_us", "Pixel dwell", 2, "µs"),
                inp("px_um", "Pixel size", 0.4, "µm"),
                inp("n_frames", "Frames", 50, ""),
                inp("i_sat", "PE saturation irradiance", 19, "kW/cm²"),
                inp("eps_pe", "PE extinction at 561 nm", 1.96e6, "M⁻¹cm⁻¹"),
                inp("phi_b", "PE photodestruction yield", 1.1e-5, "per absorbed photon"),
                inp("lam_ex", "Excitation wavelength", 0.561, "µm"),
            ], [
                out("w0_um", "Focal spot radius (1/e²)", "0.433 * lam_ex / na", "µm", 3),
                out("s_ratio", "I/Iₛ at the focus", "2 * p_uw * 1e-6 / (pi * (w0_um * 1e-4) ^ 2) / 1000 / i_sat", "", 3),
                out("abs_frame", "Photons absorbed per PE per frame", absorbed_expr("p_uw", "dwell_us", "px_um", "eps_pe", "lam_ex"), "", 1),
                out("loss_frame_pct", "PE lost per frame", "100 * (1 - exp(-phi_b * abs_frame))", "%", 3),
                out("loss_series_pct", "PE lost over the series", "100 * (1 - exp(-phi_b * abs_frame * n_frames))", "%", 1),
            ]),
            callout("note", "At [!var:p_uw] (I/Iₛ [!var:s_ratio]) each frame removes [!var:loss_frame_pct] of the PE, and [!var:n_frames] frames remove [!var:loss_series_pct]."),
        ]),
        section("Procedure", [
            heading("7a", "Bleaching per frame"),
            step("For each power, take 50 frames of a fresh field, no pauses."),
            heading("7b", "Dark state"),
            step("In two of the 7a fields, stop after frame 25, wait 60 s in the dark, then take frames 26–50."),
            heading("7c", "Saturation"),
            step("For 6 powers, take one frame of a fresh field."),
            heading("7d", "Dwell against averaging"),
            step("At one power, acquire three fresh fields with the same total dose: one frame at 8 µs; four averaged frames at 2 µs; resonant scanning with enough line integration to match."),
            heading("7e", "Antifade"),
            step("Repeat 7a at one power in the n-propyl gallate well."),
            heading("7f", "Focus cost"),
            step("Live-scan one field for 10 s at the focusing settings you would use, then acquire it and its untouched neighbour with the same settings."),
        ]),
        section("Analysis", [
            step("7a: integrated intensity per bead against frame n; fit I(n) = I(1)·exp(−k·(n − 1)). The yield is k divided by photons absorbed per frame (calculator). Plot k against dose: a straight line means the one-photon dose law holds."),
            step("7b: the fraction of the drop that recovers after the pause is the reversible dark state."),
            step("7c: fit first-frame I = a·P/(1 + P/Pₛ). Pₛ and the Exp 01 spot size give Iₛ."),
            step("7d: signal per unit dose for each mode, and bead-to-bead CV."),
            step("7e: ratio of k with and without antifade. 7f: intensity of the focused field divided by its neighbour."),
        ]),
        section("Decision & record", [
            callout("note", "Decision: the operating power (at most 5 % below linear), the scan mode, whether to use n-propyl gallate, "
                            "and the focusing rule."),
            record([("Part / field", "7a–7f, field id"), ("Power", "µW at the sample"), ("Dwell, averages, mode", "Galvano or resonant"),
                    ("Frame count", "And pause timing for 7b")]),
            DATA,
        ]),
    ]))

# ════════════════════════════════════════════════════════════════════════════════════════════════════
# 08 — Gain ladder
PROTOCOLS.append(protocol(
    8, "pe-ax-08-gain-ladder", "PE beads · Exp 08 · Detector gain ladder on real beads",
    "Image one field of bright and dim beads at six HV settings to confirm that gain only maps signal onto the ADC, and choose the plate HV.",
    ["detector", "gain", "dynamic-range"],
    [
        section("Overview", [
            doc_header("Gain ladder", "Gain multiplies signal and noise together; it buys ADC range, not SNR.",
                       ["Exp 08 of %d" % TOTAL, "≈45 min", "Photophysics block"]),
            callout("note", "Pins: that the integrated metric in photoelectrons does not depend on HV until clipping, that bead-to-bead "
                            "CV does not improve with HV, and the HV for a plate."),
            callout("assume", "Model: with a 16-bit ADC, clipping starts at gain ≈20 DN/e⁻ for 3,000 PE/µm² beads and ≈200 DN/e⁻ for "
                              "300 PE/µm². In 12-bit mode every threshold is 16× lower."),
        ]),
        section("Materials", [
            materials([("1", "well", "Mixed beads: top-standard and low-standard assay beads in one well (or one high-coverage well)"),
                       ("1", "ea", "#1.5 glass-bottom plate")]),
        ]),
        section("Settings", [
            settings([("Mode", "Default mode from Exp 05"),
                      ("HV", "6 values, from low to just clipping the brightest rim"),
                      ("Order", "Low → high → low (repeat the lowest at the end to catch bleaching)"),
                      ("Power / dwell", "Operating values from Exp 07")]),
            BEFORE,
        ]),
        section("Calculator", [
            calculator("Gain headroom", [
                inp("adc_max", "ADC full scale", 65535, "DN"),
                inp("offset_dn", "Offset", 200, "DN"),
                inp("rim_dn", "Brightest rim pixel now", 30000, "DN"),
                inp("target_frac", "Target fraction of full scale", 0.65, ""),
                inp("slope", "g·F at this HV (Exp 02)", 20, "DN per e⁻"),
            ], [
                out("gain_factor", "Multiply the current gain by", "(target_frac * adc_max - offset_dn) / (rim_dn - offset_dn)", "×", 2),
                out("rim_e", "Brightest rim in photoelectrons", "(rim_dn - offset_dn) / slope", "e⁻", 0),
            ]),
            callout("note", "The brightest rim holds [!var:rim_e]; multiply the gain by [!var:gain_factor] to put it at "
                            "[!var:target_frac] of full scale. Use the Exp 02 slope-against-HV fit to find that HV."),
        ]),
        section("Procedure", [
            step("Find a field with both bright and dim beads, focus by transmitted light, hold with Perfect Focus."),
            step("Acquire the same field at 6 HV values, low → high, then the lowest again."),
        ]),
        section("Analysis", [
            step("Convert each image to photoelectrons with the Exp 02 slope for its HV; compute the integrated metric per bead."),
            step("Plot integrated photoelectrons and bead-to-bead CV against HV. Both should be flat until rim pixels clip."),
            step("The last-minus-first low-HV image gives the bleaching the ladder caused."),
        ]),
        section("Decision & record", [
            callout("note", "Decision: one HV for a whole plate, set on the brightest standard with the rim at 60–70 % of full scale. Never auto-adjust gain."),
            record([("HV", "Value"), ("Offset", "DN"), ("Saturated pixels", "Count per image"), ("Bleach check", "First vs last low-HV image")]),
            DATA,
        ]),
    ]))

# ════════════════════════════════════════════════════════════════════════════════════════════════════
# 09 — Backgrounds
PROTOCOLS.append(protocol(
    9, "pe-ax-09-backgrounds", "PE beads · Exp 09 · Backgrounds and the real detection floor",
    "Measure free PE-antibody background and the bead excluded-volume term, bead autofluorescence, and nonspecific PE binding in each imaging mode.",
    ["background", "lod", "nonspecific-binding", "autofluorescence"],
    [
        section("Overview", [
            doc_header("Backgrounds and the detection floor", "Photon noise alone allows ≈15–20 PE per bead; the real floor is set here.",
                       ["Exp 09 of %d" % TOTAL, "≈3 h plus incubation", "Calibration block"]),
            callout("note", "Pins: the effective detection volume per mode and the excluded-volume correction for no-wash reads (9a), "
                            "bead autofluorescence (9b), and nonspecific PE binding with its bead-to-bead SD, the practical LOD (9c)."),
            table([("mode", "Mode"), ("veff", "V_eff"), ("lod0", "LOD, detector only"), ("lod1", "LOD at 1 nM free PE-Ab")], [
                {"mode": "20x, 1 AU", "veff": "0.53 µm³", "lod0": "16 PE/bead", "lod1": "106 PE/bead"},
                {"mode": "10x, 1 AU", "veff": "3.7 µm³", "lod0": "21 PE/bead", "lod1": "139 PE/bead"},
                {"mode": "10x, 4 AU", "veff": "11.2 µm³", "lod0": "14 PE/bead", "lod1": "158 PE/bead"},
            ], "Model predictions (10 µW, 2 µs, 20 px per bead)"),
        ]),
        section("Materials", [
            materials([("6", "well", "Blank beads (capture antibody, no analyte) in free PE-antibody: 0, 0.1, 0.3, 1, 3, 10 nM, no wash (9a)"),
                       ("1", "well", "Uncoated or BSA-blocked beads in PBS (9b)"),
                       ("3", "well", "Capture beads + PE-antibody at the working D₀, no analyte, full washed protocol (9c)"),
                       ("3", "well", "Same as 9c, unwashed (only if a no-wash format is planned)"),
                       ("", "", "PE-detection antibody stock; PBS; #1.5 glass-bottom plate")]),
        ]),
        section("Calculators", [
            calculator("PE-antibody working dilutions", [
                inp("stock_ugml", "Stock concentration", 100, "µg/mL"),
                inp("mw_kda", "Conjugate molecular weight", 390, "kDa", hint="R-PE 240 + IgG 150"),
                inp("work_nm", "Working dilution", 10, "nM"),
                inp("work_vol_ul", "Working dilution volume", 1000, "µL"),
                inp("final_ul", "Volume per well", 200, "µL"),
            ], [
                out("stock_nm", "Stock molarity", "stock_ugml * 1000 / mw_kda", "nM", 1),
                out("work_stock_ul", "Stock into the working dilution", "work_nm * work_vol_ul / stock_nm", "µL", 1),
            ]),
            {"kind": "builder", "attrs": {
                "label": "Free PE-antibody series (press Add all)",
                "description": "Wells up to 1 nM draw from the [!var:work_nm] working dilution; 3 and 10 nM draw from the stock.",
                "dataset": "pe_series",
                "params": [],
                "dims": [{"field": "conc", "label": "Free PE-Ab (nM)", "source": "list",
                          "options": ["0", "0.1", "0.3", "1", "3", "10"], "editable": True}],
                "derived": [
                    {"field": "source", "expr": "conc <= 1 ? \"working\" : \"stock\""},
                    {"field": "pipette_ul", "expr": "conc <= 1 ? conc * final_ul / work_nm : conc * final_ul / stock_nm"},
                    {"field": "buffer_ul", "expr": "final_ul - pipette_ul"},
                ],
                "dedupe": {"when": "", "ignore": []},
            }},
            calculator("Pipetting table", [], [], {"dataset": "pe_series", "columns": [
                {"label": "Free PE-Ab (nM)", "expr": "conc", "align": "right", "mono": True, "decimals": 1},
                {"label": "From", "expr": "source", "align": "left", "mono": False, "decimals": 0},
                {"label": "Volume (µL)", "expr": "pipette_ul", "align": "right", "mono": True, "decimals": 2},
                {"label": "PBS (µL)", "expr": "buffer_ul", "align": "right", "mono": True, "decimals": 1},
            ]}),
            calculator("Excluded-volume term", [
                inp("c_nm", "Free PE-antibody", 1, "nM"),
                inp("v_excl", "Bead volume inside the section", 268, "µm³", hint="whole bead = 268 µm³ (upper bound)"),
            ], [
                out("excl_pe", "Solution PE displaced by one bead", "c_nm * 0.6022 * v_excl", "PE", 0),
            ]),
            callout("note", "At [!var:c_nm] the bead displaces up to [!var:excl_pe] PE-equivalents of solution. Annulus subtraction "
                            "removes that much too many, so a blank bead reads negative and a no-wash assay must add it back."),
        ]),
        section("Procedure", [
            heading("9a", "Free PE-antibody"),
            step("Make the working dilution ([!var:work_stock_ul] of stock into [!var:work_vol_ul]), then the six wells from the pipetting table. Add blank beads, settle 30 min."),
            step("Image each well in modes A–D of Exp 05 at operating settings, 3 fields each."),
            heading("9b", "Autofluorescence"),
            step("Image ≥100 uncoated or blocked beads in PBS in the default mode."),
            heading("9c", "Nonspecific binding"),
            step("Run the capture beads with PE-antibody and no analyte through the full assay (incubation, washes). Image ≥100 beads per well."),
            BEFORE,
        ]),
        section("Analysis", [
            step("9a: background per pixel (photoelectrons, Exp 02) against concentration gives a slope; with the photoelectrons per PE from Exp 10 it gives V_eff per mode. The blank-bead integrated signal against concentration gives the excluded-volume slope (expected negative)."),
            step("9b: autofluorescence per bead in PE-equivalents (after Exp 10)."),
            step("9c: PE per bead from nonspecific binding: mean and SD across beads and wells. Practical LOD = mean + 3 SD."),
        ]),
        section("Decision & record", [
            callout("note", "Decision: washed versus no-wash format, and which mode the no-wash read needs. 9c sets the LOD target for the assay."),
            record([("Well", "Contents and free PE-Ab nM"), ("Mode", "A–D"), ("Washed", "Yes / no"), ("Beads", "Number analysed")]),
            DATA,
        ]),
    ]))

# ════════════════════════════════════════════════════════════════════════════════════════════════════
# 10 — Absolute calibration
PROTOCOLS.append(protocol(
    10, "pe-ax-10-pe-calibration", "PE beads · Exp 10 · Absolute calibration to PE per bead",
    "Calibrate intensity to PE molecules per bead with PE quantitation beads, measure PE per detection antibody, and the capture-site distribution.",
    ["calibration", "mesf", "quantibrite", "site-density"],
    [
        section("Overview", [
            doc_header("Absolute calibration", "Turns photoelectrons into PE molecules per bead, and PE into analyte.",
                       ["Exp 10 of %d" % TOTAL, "≈2 h; repeat the calibration wells on every plate", "Calibration block"]),
            callout("note", "Pins: photoelectrons per PE molecule in each mode; the PE:IgG ratio of the conjugate; the capture-site "
                            "number per bead and its bead-to-bead CV, which sets beads per well."),
            callout("critical", "Calibration beads differ from assay beads in size and label geometry. Simulate both with the "
                                "model (render with their radius and shell or volume label) to transfer the calibration, or "
                                "acquire the calibration wells as a 5-plane sum, which removes the geometry dependence."),
        ]),
        section("Materials", [
            materials([("1", "kit", "PE quantitation beads, 4 levels + blank, lot-specific PE per bead (MESF / Quantibrite type)"),
                       ("2", "well", "Assay beads at saturating analyte + saturating PE-antibody, 2 h, washed (site distribution)"),
                       ("1", "ea", "UV-vis spectrophotometer or NanoDrop for the conjugate A565 and A280"),
                       ("", "", "PBS; #1.5 glass-bottom plate")]),
        ]),
        section("Calculators", [
            calculator("PE per detection antibody (absorbance)", [
                inp("a565", "Conjugate A565", 1.96, ""),
                inp("a280", "Conjugate A280", 0.602, ""),
                inp("eps_pe", "R-PE extinction at 565 nm", 1.96e6, "M⁻¹cm⁻¹"),
                inp("eps_igg", "IgG extinction at 280 nm", 2.1e5, "M⁻¹cm⁻¹"),
                inp("cf_pe", "R-PE A280/A565", 0.2, "", hint="from the PE vendor; ≈0.2 assumed"),
            ], [
                out("n_pe", "PE per IgG", "(a565 / eps_pe) / ((a280 - cf_pe * a565) / eps_igg)", "", 2),
            ]),
            calculator("Intensity to molecules", [
                inp("e_bead", "Bead integrated signal", 50000, "e⁻"),
                inp("e_blank", "Blank-bead integrated signal", 500, "e⁻"),
                inp("slope_pe", "Calibration slope", 0.8, "e⁻ per PE"),
                inp("bead_area", "Bead surface area", 201.1, "µm²"),
            ], [
                out("pe_bead", "PE per bead", "(e_bead - e_blank) / slope_pe", "PE", 0),
                out("pe_um2", "PE surface density", "pe_bead / bead_area", "PE/µm²", 2),
                out("analyte_bead", "Captured, labelled analyte per bead", "pe_bead / n_pe", "", 0),
            ]),
            calculator("Beads per well", [
                inp("cv_pct", "Bead-to-bead CV (saturation wells)", 5, "%"),
                inp("se_pct", "Target standard error of the well median", 1, "%"),
            ], [
                out("n_beads", "Beads to analyse per well", "ceil((1.25 * cv_pct / se_pct) ^ 2)", "", 0),
            ]),
            callout("note", "A bead at [!var:e_bead] is [!var:pe_bead] ([!var:pe_um2]), i.e. [!var:analyte_bead] labelled analyte "
                            "molecules at [!var:n_pe] PE per IgG. At [!var:cv_pct] CV, analyse [!var:n_beads] beads per well."),
        ]),
        section("Procedure", [
            step("Measure A565 and A280 of the PE-antibody conjugate (blank on its buffer)."),
            step("Resuspend the calibration beads as the kit says; one well per level plus the blank, in PBS."),
            step("Run two saturation wells: assay beads with analyte at the top of the expected range ×10 and PE-antibody at ≥10× its K_D, 2 h with rotation, washed."),
            step("Settle 30 min. Image every well in the default mode at operating settings, ≥100 beads per well. Repeat the calibration wells as a 5-plane sum (2 µm steps around the equator)."),
            BEFORE,
        ]),
        section("Analysis", [
            step("Fit integrated photoelectrons against the lot PE per bead (linear, intercept at the blank). The slope is photoelectrons per PE. Check linearity across the four levels."),
            step("Transfer to assay-bead geometry with the simulator, or use the 5-plane-sum slope directly."),
            step("Saturation wells: PE per bead distribution. Subtract the photon-noise variance (≈F × mean, in photoelectrons) from the observed variance. The remainder is the capture-site CV."),
            step("Optional cross-check: run the assay beads and the calibration kit on a flow cytometer."),
        ]),
        section("Decision & record", [
            callout("note", "Decision: the conversion used for every plate, the beads per well, and whether the capture-site CV is acceptable."),
            record([("Kit lot", "PE per bead for each level"), ("Mode", "Single plane or 5-plane sum"),
                    ("Conjugate", "A565, A280, lot"), ("Beads", "Number analysed per well")]),
            DATA,
        ]),
    ]))

# ════════════════════════════════════════════════════════════════════════════════════════════════════
# 11 — Kinetics
PROTOCOLS.append(protocol(
    11, "pe-ax-11-binding-kinetics", "PE beads · Exp 11 · Rate constants, settling and depletion",
    "Measure association, post-wash dissociation, delayed detection and a detection-antibody clamp to separate the two off-rates; test settling and bead number.",
    ["kinetics", "koff", "kon", "depletion", "settling"],
    [
        section("Overview", [
            doc_header("Rate constants, settling and depletion", "PE after the wash decays at k₋₂ + k₋₃; separating the two needs a perturbation.",
                       ["Exp 11 of %d" % TOTAL, "2–3 sessions", "Assay block"]),
            callout("note", "Pins: k₁ and k₂ (11a), k₋₂ + k₋₃ and rebinding (11b), k₋₁ (11c), k₋₃ and the k₋₃ ≈ k₋₁ assumption "
                            "(11d), settling and transport (11e), and analyte depletion by the beads (11f)."),
            callout("critical", "Image every time point in a fresh well or a fresh field, once. Re-imaging a field bleaches the next "
                                "time point. Keep the wash-to-image time fixed."),
        ]),
        section("Materials", [
            materials([("", "", "Assay beads at a fixed number per well"),
                       ("", "", "Analyte standard"),
                       ("", "", "PE-detection antibody"),
                       ("", "", "Unlabelled detection antibody, ≈100 nM in the 11b blocking arm"),
                       ("1", "ea", "Tube rotator (end-over-end) and orbital shaker"),
                       ("", "", "Wash buffer; #1.5 glass-bottom plates")]),
        ]),
        section("Calculators", [
            calculator("Signal lost after the wash", [
                inp("k_sum", "k₋₂ + k₋₃", 0.001, "s⁻¹"),
                inp("delay_min", "Wash-to-image delay", 10, "min"),
                inp("scan_min", "Plate scan duration", 20, "min"),
            ], [
                out("t_half_min", "Half-life of the PE signal", "log(2) / k_sum / 60", "min", 1),
                out("loss_delay_pct", "Lost before the first well is imaged", "100 * (1 - exp(-k_sum * delay_min * 60))", "%", 1),
                out("spread_pct", "Extra loss by the last well", "100 * (1 - exp(-k_sum * scan_min * 60))", "%", 1),
            ]),
            calculator("Labelled fraction during a clamp", [
                inp("k2", "Detection-antibody on-rate", 4e5, "M⁻¹s⁻¹"),
                inp("d0_nm", "PE-antibody during the clamp", 10, "nM"),
                inp("km2", "Detection-antibody off-rate k₋₂", 0.001, "s⁻¹"),
            ], [
                out("f_lab", "Labelled fraction f", "k2 * d0_nm * 1e-9 / (k2 * d0_nm * 1e-9 + km2)", "", 3),
                out("t_relabel_min", "Time to re-label 95 %", "3 / (k2 * d0_nm * 1e-9 + km2) / 60", "min", 1),
            ]),
            calculator("Bead settling (Stokes)", [
                inp("d_um", "Bead diameter", 8, "µm"),
                inp("drho", "Density difference (polystyrene ≈0.05)", 0.05, "g/mL"),
                inp("visc", "Viscosity", 1.0, "mPa·s"),
                inp("h_mm", "Liquid height", 3, "mm"),
            ], [
                out("v_ums", "Settling speed", "2 / 9 * drho * 1000 * 9.81 * (d_um / 2 * 1e-6) ^ 2 / (visc * 1e-3) * 1e6", "µm/s", 2),
                out("t_settle_min", "Time to settle the column", "h_mm * 1000 / v_ums / 60", "min", 0),
            ]),
            callout("note", "With k₋₂ + k₋₃ = [!var:k_sum] the PE signal halves every [!var:t_half_min]; [!var:loss_delay_pct] is gone "
                            "by the first well and a further [!var:spread_pct] by the last. Beads settle [!var:h_mm] of liquid in "
                            "[!var:t_settle_min]. During a clamp at [!var:d0_nm], a fraction [!var:f_lab] of captured analyte is labelled."),
        ]),
        section("Procedure", [
            heading("11a", "Association, one-step"),
            step("Analyte at ≈0.1×, 1× and 10× the expected K_D1, PE-antibody at the working D₀, all added together to the beads. Rotate."),
            timeline("Stop (wash) and image at", [("5 min", "5", ""), ("15 min", "15", ""), ("30 min", "30", ""), ("60 min", "60", ""),
                                                  ("120 min", "120", ""), ("240 min", "240", ""), ("overnight", "≈16 h", "")]),
            heading("11b", "Dissociation after the wash (k₋₂ + k₋₃)"),
            step("Equilibrate one-step at a mid concentration (overnight, rotating). Wash. Split into two arms: plain buffer, and buffer with ≈100 nM unlabelled detection antibody (blocks rebinding)."),
            step("Image fresh fields every 5 min for 2–4 h in both arms."),
            heading("11c", "Delayed detection (k₋₁)"),
            step("Two-step: capture analyte without PE-antibody, wash, hold in buffer for 0, 15, 30, 60, 120, 240 min (separate wells)."),
            step("At each hold time add saturating PE-antibody for a fixed time (≥ the re-label time in the calculator), wash, image."),
            callout("note", "Same-bead variant: after a one-step incubation and wash, hold, image one set of fields as is (decays at "
                            "k₋₂ + k₋₃), then relabel the same well and image fresh fields (decays at k₋₁). The ratio cancels "
                            "bead-to-bead site variation."),
            heading("11d", "Clamp with PE-antibody present (k₋₃)"),
            step("After a one-step equilibrium, replace the liquid with buffer containing PE-antibody at D₀ and no analyte. Image fresh fields over 2–4 h in the no-wash mode (20x, 1 AU)."),
            heading("11e", "Settling and transport"),
            step("One mid concentration, 2 h, three arms: static, orbital shaking, end-over-end rotation."),
            heading("11f", "Bead number"),
            step("A low analyte concentration with 1,000, 5,000 and 20,000 beads in the same volume, 2 h, rotating."),
            BEFORE,
        ]),
        section("Analysis", [
            step("11a: global fit of the binding model (Research/bead_confocal_sim/binding.py) to all time points and concentrations, with bead number and volume fixed: k₁ and k₂."),
            step("11b: fit PE(t) = PE(0)·exp(−Λt) in each arm. If the arms agree, rebinding is negligible and Λ = k₋₂ + k₋₃."),
            step("11c: PE against hold time decays at k₋₁. With k₋₃ ≈ k₋₁, k₋₂ = Λ − k₋₁. If capture is nearly irreversible (≈3 × 10⁻⁶ s⁻¹ has been reported for a PSA capture antibody), 11b alone measures k₋₂ and 11c bounds k₋₁."),
            step("11d: PE decays at f·k₋₃ + (1 − f)·k₋₁ (f from the calculator); at f near 1 that is k₋₃. Compare with 11c."),
            step("11e: static versus rotation is the settling effect; shaking versus rotation is per-bead transport (Damköhler number)."),
            step("11f: PE per bead falling with bead number means analyte depletion; bead number must then be held fixed."),
        ]),
        section("Decision & record", [
            callout("note", "Decision: incubation time and mixing, the fixed bead number, the wash-to-image window (or a no-wash read), "
                            "and the rate constants for the standard-curve model."),
            record([("Arm / time point", "Incubation, hold or chase time"), ("Wash-to-image", "Minutes"), ("Beads per well", "Count"),
                    ("Concentrations", "Analyte, PE-antibody, unlabelled antibody")]),
            DATA,
        ]),
    ]))

# ════════════════════════════════════════════════════════════════════════════════════════════════════
# 12 — Standard curve and hook (builder + plate map)
STEPS12 = [str(i) for i in range(12)]
PROTOCOLS.append(protocol(
    12, "pe-ax-12-standard-curve", "PE beads · Exp 12 · Standard curve and hook",
    "A 12-point half-log analyte titration at three detection-antibody levels in duplicate on one 96-well plate, with reference wells, to fit the model and locate the hook.",
    ["standard-curve", "hook", "dose-response", "plate-layout"],
    [
        section("Overview", [
            doc_header("Standard curve and hook", "One plate: 11 analyte points plus a blank × 3 D₀ levels × duplicate, plus references.",
                       ["Exp 12 of %d" % TOTAL, "≈1 day", "Assay block"]),
            callout("note", "Pins: S_T, K_D1 and K_D2 by a global fit of the mechanistic model, a routine 4PL/5PL, the hook onset, and "
                            "the working D₀. The PE ceiling is S_T·D₀/(K_D2 + D₀), so D₀ well above K_D2 is needed to approach "
                            "saturation, at the cost of more background."),
        ]),
        section("Materials", [
            materials([("", "", "Assay beads at the fixed number per well (Exp 11)"),
                       ("", "", "Analyte standard, enough for the top tube"),
                       ("", "", "PE-detection antibody"),
                       ("", "", "PE calibration beads, 4 levels + blank (reference row)"),
                       ("", "", "Assay diluent; wash buffer"),
                       ("1", "ea", "96-well #1.5 glass-bottom plate (or incubate in tubes and transfer)"),
                       ("1", "ea", "Tube rotator")]),
        ]),
        section("Plate", [
            calculator("Dilution series", [
                inp("top_pm", "Top analyte concentration", 100000, "pM", hint="2–3 points above the expected range, for the hook"),
                inp("factor", "Dilution factor (half-log = 3.1623)", 3.1623, ""),
                inp("kd2_nm", "Detection-antibody K_D (Exp 11)", 2, "nM"),
                inp("well_ul", "Volume per well", 100, "µL"),
                inp("wells_per_std", "Wells per standard (3 D₀ × 2)", 6, ""),
                inp("overage", "Overage", 1.2, ""),
            ], [
                out("low_pm", "Lowest standard", "top_pm / factor ^ 10", "pM", 3),
                out("std_vol_ul", "Volume of each standard", "well_ul * wells_per_std * overage", "µL", 0),
                out("transfer_ul", "Transfer between tubes", "std_vol_ul / (factor - 1)", "µL", 1),
                out("top_tube_ul", "Top tube volume", "std_vol_ul + transfer_ul", "µL", 1),
            ]),
            callout("note", "Make [!var:top_tube_ul] of the top standard ([!var:top_pm]). Each next tube holds [!var:std_vol_ul] of diluent "
                            "and receives [!var:transfer_ul] from the tube before; the 11th point is [!var:low_pm]."),
            {"kind": "builder", "attrs": {
                "label": "Plate layout (press Add all)",
                "description": "Rows A–F: one D₀ level and replicate per row, blank in column 1 then rising analyte. Rows G–H: references.",
                "dataset": "plate",
                "params": [],
                "dims": [
                    {"field": "d0x", "label": "D₀ (× K_D2)", "source": "list", "options": ["0.3", "1", "3"], "editable": True},
                    {"field": "rep", "label": "Replicate", "source": "list", "options": ["a", "b"], "editable": True},
                    {"field": "step", "label": "Point (0 = blank)", "source": "list", "options": STEPS12, "editable": False},
                ],
                "derived": [
                    {"field": "conc_pm", "expr": "step == 0 ? 0 : top_pm / factor ^ (11 - step)"},
                    {"field": "d0_nm", "expr": "d0x * kd2_nm"},
                ],
                "dedupe": {"when": "", "ignore": []},
            }},
            {"kind": "layoutMap", "attrs": {
                "label": "96-well plate", "dataset": "plate", "rows": 8, "cols": 12,
                "cellLabel": "conc_pm", "cellSub": "d0_nm", "colorField": "d0x", "spareLabel": "ref"}},
            table([("well", "Wells"), ("contents", "Reference contents")], [
                {"well": "G1–G5", "contents": "PE calibration beads, blank + 4 levels"},
                {"well": "G6–G7", "contents": "Saturation wells (top analyte × 10, saturating PE-antibody)"},
                {"well": "G8–G10", "contents": "Capture beads + PE-antibody, no analyte (nonspecific binding)"},
                {"well": "G11", "contents": "Uncoated beads in buffer (autofluorescence)"},
                {"well": "G12, H1–H12", "contents": "Spare: sample duplicates at two dilutions (hook check)"},
            ], "Rows G–H"),
        ]),
        section("Procedure", [
            step("Prepare the serial dilution in tubes with the volumes above; change tips at every transfer."),
            step("For each well: beads (fixed number), analyte standard, PE-antibody at d0_nm, added together (one-step). Incubate 2 h with rotation (or the time chosen in Exp 11)."),
            step("Wash 3× (or keep unwashed for a no-wash read). Fill the reference wells."),
            step("Settle 30 min. Image every well in the default mode at operating settings, the same order every run, with a fixed wash-to-image time; ≥ the beads-per-well number from Exp 10."),
            BEFORE,
        ]),
        section("Analysis", [
            step("Per well: median integrated intensity, converted to PE per bead with the reference calibration beads of this plate."),
            step("Global fit of the mechanistic model (S_T, K_D1, K_D2; D₀ and bead number known) across all three D₀ levels. For routine use, fit a 5PL per D₀ level."),
            step("Hook onset: the concentration where signal turns down. LOD: blank mean + 3 SD, read through the curve."),
        ]),
        section("Decision & record", [
            callout("note", "Decision: the working D₀, the curve model for routine runs, and the dilution rule for samples near the hook."),
            record([("Well", "Plate position"), ("Analyte", "pM"), ("D₀", "nM"), ("Incubation", "Time, mixing"),
                    ("Wash-to-image", "Minutes"), ("Beads", "Number analysed per well")]),
            DATA,
        ]),
    ]))

# ════════════════════════════════════════════════════════════════════════════════════════════════════
# 13 — Head-to-head mode validation
PROTOCOLS.append(protocol(
    13, "pe-ax-13-mode-validation", "PE beads · Exp 13 · Head-to-head of the measurement modes",
    "Image one standard-curve plate in four candidate modes, three times in a day and on three days, and score LOD, CV, slope, throughput, bleaching and repeatability.",
    ["validation", "repeatability", "throughput", "method-selection"],
    [
        section("Overview", [
            doc_header("Head-to-head of the measurement modes", "Chooses the default protocol from data, not from the model.",
                       ["Exp 13 of %d" % TOTAL, "≈1 day + 2 short sessions", "Validation block"]),
            callout("assume", "Model expectation: mode A is the most focus-tolerant and fastest for washed assays; mode B or C wins for "
                              "no-wash reads and the lowest signals."),
            table([("mode", "Mode"), ("obj", "Objective / pinhole"), ("z", "Planes"), ("px", "Pixels per bead")], [
                {"mode": "A", "obj": "10x, pinhole open", "z": "1 (equator)", "px": "12–20"},
                {"mode": "B", "obj": "20x, 1 AU", "z": "1 (equator, Perfect Focus)", "px": "16–25"},
                {"mode": "C", "obj": "20x, 1 AU", "z": "5-plane sum, 2 µm steps (±4 µm)", "px": "16–25"},
                {"mode": "D", "obj": "10x, 1 AU", "z": "1 (equator)", "px": "12–20"},
            ], "Candidate modes"),
        ]),
        section("Materials", [
            materials([("1", "plate", "A standard-curve plate made as in Exp 12, with its reference rows")]),
        ]),
        section("Calculator", [
            calculator("Throughput per mode", [
                inp("m_obj", "Objective magnification", 10, "×"),
                inp("zoom", "Scan zoom", 1, "×"),
                inp("n_px", "Frame size", 4096, "px"),
                inp("dwell_us", "Pixel dwell", 2, "µs"),
                inp("n_avg", "Averages × planes", 1, ""),
                inp("density", "Bead density on the glass", 200, "per mm²"),
            ], [
                out("field_mm2", "Field area", "(17.7 / (m_obj * zoom)) ^ 2", "mm²", 3),
                out("ppb_13", "Pixels per bead", "8 / (17700 / (m_obj * zoom) / n_px)", "px", 1),
                out("beads_field", "Beads per field", "density * field_mm2", "", 0),
                out("frame_s", "Acquisition per field", "n_px ^ 2 * dwell_us * n_avg * 1e-6", "s", 1),
                out("beads_min", "Beads per minute", "beads_field / frame_s * 60", "", 0),
            ]),
            callout("note", "This mode gives [!var:ppb_13] pixels per bead, [!var:beads_field] beads per field and [!var:beads_min] beads per minute of acquisition."),
        ]),
        section("Procedure", [
            step("Image the whole plate in modes A–D. Rotate the mode order between passes so no mode always goes first."),
            step("Day 1: three complete passes. Days 2 and 3: one pass each, with the reference rows and Exp 01/03 session checks."),
            BEFORE,
        ]),
        section("Analysis", [
            table([("metric", "Score"), ("how", "How")], [
                {"metric": "LOD", "how": "Blank beads mean + 3 SD, in PE per bead and in pM"},
                {"metric": "CV per well", "how": "Bead-to-bead CV of the integrated metric, median over wells"},
                {"metric": "Slope", "how": "Standard-curve slope in its linear range"},
                {"metric": "Throughput", "how": "Beads measured per minute (calculator)"},
                {"metric": "Bleaching per pass", "how": "Reference-well signal, pass 1 against pass 3"},
                {"metric": "Repeatability", "how": "Day-to-day CV after calibration with the reference rows"},
            ], "Score sheet, one column per mode"),
        ]),
        section("Decision & record", [
            callout("note", "Decision: the default protocol (mode and settings). It becomes the routine acquisition protocol."),
            record([("Pass", "Day and pass number"), ("Mode", "A–D"), ("Mode order", "Within the pass"), ("Wash-to-image", "Per well")]),
            DATA,
        ]),
    ]))


def main():
    os.makedirs(HERE, exist_ok=True)
    names = []
    for p in PROTOCOLS:
        slug = p["protocol"]["id"]
        path = os.path.join(HERE, slug + ".protocol-import.json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(p, fh, ensure_ascii=False, indent=1)
            fh.write("\n")
        names.append(os.path.basename(path))
    print("\n".join(names))


if __name__ == "__main__":
    main()
