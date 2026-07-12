---
name: protocol-import
description: Convert an existing lab protocol file (.md, .docx, or .pdf) into the McGhee Lab RM Protocols Builder import JSON format. Output is one `.protocol-import.json` file the user uploads via the "📥 Import" button on `mcgheelab.com/rm/pages/protocols.html`. Detect calculations and emit `formula` blocks with named variables so the protocol becomes a live calculator. Extract embedded images, base64-encode them, and embed in `figure` blocks. Use when the user has a Word doc, PDF, or markdown protocol and asks to import it into RM.
---

# /protocol-import — author a `.protocol-import.json` for RM

This skill is the *authoring* half of RM's Protocols Builder import flow. It does NOT touch Firestore or the live RM site. It produces a single `<slug>.protocol-import.json` file in the user's current working directory that the user later uploads via the "📥 Import" button on `mcgheelab.com/rm/pages/protocols.html`.

The drop side is implemented in `rm/js/protocol-import.js` (parser + validator + image upload + Firestore write + auto v1 snapshot via `PROTOCOL_VERSIONS.saveVersion`). Keep this file's format in sync with that parser.

## When to invoke

The user has a protocol in a non-RM format (`.md`, `.docx`, `.pdf`) and asks something like:

- "Convert this Matrigel protocol into the RM format"
- "Import `Agarose LLS -Sieves.md` so I can load it on the protocols page"
- "Turn this PDF SOP into a JSON I can drop into RM"

## Inputs you need

1. **Source file** — path to the `.md` / `.docx` / `.pdf`. If the user only describes a protocol verbally, ask whether they want a fresh draft or have an existing source.
2. **Title** — usually obvious from the source file's heading or filename. Confirm with the user if ambiguous.
3. **Slug** — kebab-case identifier, must be unique within the lab's `protocols` collection. Default: slugified title. The page-side importer also accepts a slug at upload time, so it's OK to leave the JSON's `protocol.id` empty and let the user pick at upload.
4. **Category / tags** — optional. Pull from filename context or ask if non-obvious.

## Source format support

| Format | How to read | Image extraction |
|---|---|---|
| `.md` | `Read` tool | Image references like `![alt](path/to/img.png)`: `Read` the local image file (the Read tool returns binary content for images) and base64-encode. |
| `.pdf` | `Read` tool with `pages` parameter for files >10 pages | `pdfimages -png path/to/file.pdf /tmp/proto-img` via Bash; then `base64 /tmp/proto-img-000.png` per image. |
| `.docx` | Bash: `unzip -p file.docx word/document.xml` for text; or convert to .md first via `pandoc file.docx -o file.md --extract-media=/tmp/docx-media` | Images in `/tmp/docx-media/media/*` after pandoc conversion; base64-encode each. |

For `.docx`, prefer the pandoc round-trip if `pandoc` is available — it normalizes lists, tables, and embedded images into `.md` form that's much easier to convert further. Fall back to direct .docx XML parsing only if pandoc isn't installed.

## Output: `<slug>.protocol-import.json` in the cwd

```json
{
  "format": "protocol-import-v1",
  "source": { "kind": "md", "filename": "Agarose LLS -Sieves.md" },
  "protocol": {
    "id": "",
    "title": "Agarose LLS — Sieves",
    "summary": "Sieving polymerized agarose into LLS particles for 3D bioprinting support baths.",
    "category": "hydrogel",
    "tags": ["agarose", "lls", "sieving"],
    "tree": {
      "meta": {},
      "sections": [
        {
          "label": "Experimental Design",
          "children": [
            {
              "kind": "materials",
              "attrs": {
                "rows": [
                  { "qty": "2",  "unit": "ea", "free_text": "40 mL beakers", "item_ref": null },
                  { "qty": "1",  "unit": "ea", "free_text": "Burger press", "item_ref": null },
                  { "qty": "1X", "unit": "",   "free_text": "PBS",          "item_ref": null }
                ]
              }
            }
          ]
        },
        {
          "label": "Protocol",
          "children": [
            {
              "kind": "formula",
              "attrs": {
                "label": "Agarose mass",
                "description": "Mass of dry agarose to weigh out for a target volume + weight%.",
                "expression": "vol * wt_pct / 100",
                "variables": [
                  { "name": "vol",    "label": "Final volume",   "default": 5, "unit": "mL" },
                  { "name": "wt_pct", "label": "Weight percent", "default": 2, "unit": "%"  }
                ],
                "output": { "name": "agarose_mass", "label": "Agarose mass", "unit": "g", "decimals": 3 }
              }
            },
            {
              "kind": "step",
              "body": "Calculate needed agarose. Example: [!var:vol] of [!var:wt_pct] agarose → [!var:agarose_mass]."
            },
            {
              "kind": "step",
              "body": "Measure out agarose on analytical balance, add to a 40 mL conical."
            },
            {
              "kind": "safety",
              "body": "Boiling water is HOT. Use clamps and PPE.",
              "attrs": { "severity": "warning" }
            },
            {
              "kind": "figure",
              "body": "Sieve stack assembly, smallest to largest from bottom to top.",
              "attrs": {
                "image_data_uri": "data:image/png;base64,iVBORw0KGgo...",
                "image_alt": "Stacked sieves with collection pan",
                "width_pct": 80
              }
            }
          ]
        }
      ]
    }
  }
}
```

### Field reference

- **`format`** — must be `"protocol-import-v1"`. The page-side importer rejects any other value.
- **`source`** — `kind` is one of `md|docx|pdf|other`; `filename` for the auto-snapshot label.
- **`protocol.id`** — kebab-case slug, or empty (user picks at upload time).
- **`protocol.title`** — required, non-empty.
- **`protocol.summary`** — one-line description shown on cards and in the lab-notebook chip tooltip. Strongly encouraged.
- **`protocol.tree.sections[]`** — each `{ label, children: [block] }`. Order matters.
- **Blocks** — each is `{ kind, body?, attrs? }`. Closed kind list: `materials`, `step`, `figure`, `formula`, `callout`, `heading`, `docHeader`, `table`, `kv`, `timeline`, `calculator`, `builder`, `layoutMap`. Legacy `note`/`safety` still import (they fold into `callout` at render time) but **emit `callout` for new protocols**. (`python` is reserved; do not emit it.)

### Block kind detection rules (heuristics for source → blocks)

| Source pattern | → Block |
|---|---|
| Numbered list item (`1. …`, `2. …`) | `step` (one block per item, body = item text) |
| `Note:`, `Tip:`, `📝`-prefixed paragraph | `callout` with `attrs.type: 'note'` |
| `Assumption:`, "assume …" preamble | `callout` with `attrs.type: 'assume'` |
| `Warning:`, `Caution:`, `Danger:`, `⚠`-prefixed | `callout` with `attrs.type: 'critical'` |
| Active-time / duration note ("~15 min hands-on") | `callout` with `attrs.type: 'timing'` |
| Two-column table at the top of the protocol with equipment + reagents | `materials` (`attrs.rows[]`); split rows by line, parse `qty`/`unit` if obvious, otherwise dump into `free_text` and leave `qty: ""`. **Always set `item_ref: null`** — the page-side matcher links to inventory, not you. |
| Figure with caption (`![alt](path)` + caption line OR PDF inline image) | `figure` with embedded `image_data_uri` + caption in `body` |
| Section header (`# Materials`, `## Protocol`, etc.) | New `section`, label = header text. |
| `Note:`/`Tip:`/`Assumption:`/timing prose | `callout` (see below) — preferred over legacy `note`/`safety`. |

## Document-chrome & widget kinds (V3.315–V3.324)

Releases 1–4 added block kinds that turn a protocol into an interactive
document. Emit them when the source calls for them; the read-only
**document view** (`?protocol=<id>&view=doc`) renders sliders, live
calculators, plate maps, and print-to-PDF from these.

**`callout`** — generalized note/safety/assumption/timing.
`attrs.type ∈ critical | note | assume | timing`. `timing` renders as a
pill (use for "15–30 min active" durations). Body is the text.

```json
{ "kind": "callout", "body": "Boiling water is HOT — use clamps + PPE.", "attrs": { "type": "critical" } }
```

**`heading`** — a sub-stage heading inside a section.
`attrs: {code, rule}` (code like `"03"`, `rule` draws a top hairline);
body = title.

**`docHeader`** — branded masthead for the doc view. `attrs: {brand,
title, chips}` where `chips` is `[{text, var}]` (var optionally names a
symbol-table variable whose live value renders after the text); body =
subtitle. At most one per protocol. Leave `brand` empty to inherit the
lab brand.

**`table`** — generic table. `attrs.columns` is
`[{key, label, align:'left'|'center'|'right', mono}]`, `attrs.rows` is
`[{<key>: "cell text"}]`; body = optional caption. Cell text supports
the inline vocabulary below.

**`kv`** — definition / derivation list. `attrs.items` is
`[{term, def}]`. Use for appendix-style variable glossaries.

**`timeline`** — horizontal track. `attrs.marks` is
`[{at, label, sub, included}]` (`at` = tick caption like `"0 min"`;
`included:false` renders a point that's on the axis but not run); body =
optional title.

**`calculator`** — multi-input calculator (upgrade of `formula` for
richer panels). `attrs`:
- `inputs`: `[{name, label, widget:'slider'|'number', min, max, step, unit, rangeHint, default}]` — published to the shared symbol table, so `[!var:name]` works everywhere.
- `outputs`: `[{name, label, expr, unit, decimals}]` — hero cards; `expr` is a mathjs expression over the inputs (and any other symbol-table variable). Each output's `name` is itself a variable.
- `table`: `{dataset, columns:[{label, expr, align, mono, decimals}]}` — a computed table whose column expressions evaluate per row over a named dataset produced by a `builder`.

```json
{ "kind": "calculator", "attrs": {
  "label": "Batch volumes",
  "inputs": [
    { "name": "n_cond", "label": "Conditions", "widget": "slider", "min": 1, "max": 24, "step": 1, "default": 6 },
    { "name": "vol_per", "label": "Vol / well", "widget": "number", "default": 0.5, "unit": "mL" }
  ],
  "outputs": [
    { "name": "total_vol", "label": "Total volume", "expr": "n_cond * vol_per * 1.1", "unit": "mL", "decimals": 2 }
  ],
  "table": { "dataset": "", "columns": [] }
} }
```

**`builder`** — parameter-sweep / condition-matrix assembler that
produces a named dataset (consumed by `calculator.table` and
`layoutMap`). `attrs`:
- `dataset`: output name (e.g. `"conditions"`).
- `params`: `[{name, label, min, max, step, default, unit, lt}]` — sliders published to the symbol table; `lt` names another param this one must stay strictly below (monotonic chains like Lₛ<L_M<L_L).
- `dims`: `[{field, label, source:'params'|'list', options, editable}]` — one segmented picker each. `source:'list'` picks a string option (`editable:true` lets the doc-view user add/remove options — the ratio editor); `source:'params'` picks which param.
- `derived`: `[{field, expr}]` — per-row computed fields (mathjs, row scope).
- `dedupe`: `{when, ignore}` — rows where `when` (row expr) is truthy get `ignore` fields blanked before de-duplication (covers f=1 inert-merges).

**`layoutMap`** — renders a named dataset as a plate grid. `attrs:
{label, dataset, rows, cols, cellLabel, cellSub, colorField,
spareLabel}` — `cellLabel`/`cellSub` are per-row mathjs expressions
(bare field names work; strings pass through), `colorField` tints wells
by distinct value, unused wells show `spareLabel`.

**Inline vocabulary** (works in any prose body — steps, callouts, table
cells, kv defs, timeline labels):
- `[!var:name]` — live symbol-table value chip.
- `[!inv:id]` — inventory chip (don't emit; leave inventory linking to the page-side matcher).
- `[!pill:functional:some text]` / `[!pill:inert:…]` — styled tags (functional/inert get dedicated colors).
- `` `code` `` — inline code; `~text~` — subscript; `^text^` — superscript.

### Calculation extraction (the killer feature)

Treat any prose with arithmetic like a calculator definition. Build one `formula` block per distinct computation, then **rewrite the prose to reference the variables** so changing the input updates the output everywhere.

| Source prose | → `formula` block | Step body becomes |
|---|---|---|
| "5 mLs of 2% wt agarose: 5 mL × 0.02 = 0.1 g agarose" | label: `Agarose mass`<br>expression: `vol * wt_pct / 100`<br>vars: `vol=5 mL`, `wt_pct=2 %`<br>output: `agarose_mass / g / 3 dec` | "Use [!var:agarose_mass] of agarose for a [!var:vol] batch at [!var:wt_pct]." |
| "Use 1:1000 dilution of antibody (2 µL into 2 mL)" | label: `Antibody volume`<br>expression: `total_vol / dilution`<br>vars: `total_vol=2000 µL`, `dilution=1000`<br>output: `ab_vol / µL / 1 dec` | "Add [!var:ab_vol] of antibody to [!var:total_vol] of buffer (1 : [!var:dilution] dilution)." |
| "Spin at 1500 rpm for 5 minutes" | (no formula — fixed values) | "Spin at 1500 rpm for 5 minutes." |

**Rules for formula blocks:**

1. **Variable names must be `snake_case` and short** (`vol`, `wt_pct`, `total_vol`, `ab_vol`, `agarose_mass`). The lab-notebook calculator UI keys off these; a stable name means a notebook entry can render `[!var:agarose_mass]` chips that resolve correctly.
2. **Every variable needs a label and unit.** The label shows in the calculator panel; the unit shows in chips.
3. **Expression must be a valid mathjs expression.** No JS function calls, no side effects. Arithmetic + unit conversions are fine: `vol * wt_pct / 100`, `5 * mL * 0.02 g/mL`.
4. **Output `decimals` defaults to 3.** Bump for high-precision (5–6) or drop for whole-number outputs (0).
5. **Reuse outputs across formulas.** A formula can reference another formula's `output.name` as an input variable, so chained calculations work (`agarose_mg = agarose_mass * 1000`).
6. **Don't fabricate variables that aren't in the source.** If the source says "spin at 1500 rpm for 5 minutes" and never asks the reader to vary that, leave it as plain prose. The user can promote it to a formula later if they want.

**`formula` vs `calculator` vs `builder` — which to emit:**

- **`formula`** — a single computation with a handful of inputs and one output. Simplest; still fully supported.
- **`calculator`** — a *panel* of related inputs (some as sliders with min/max/step) feeding one or more hero-card outputs, optionally with a computed table. Use when the source presents a "plug in your numbers" worksheet with ranges.
- **`builder` + `layoutMap`** — when the source describes assembling a *matrix of conditions* (a parameter sweep, a plate layout, "for each combination of X and Y…"). The builder produces a named dataset; a `calculator` with a `table` over that dataset computes per-condition volumes; a `layoutMap` shows the plate. Only reach for this when the source genuinely has a combinatorial design — don't over-engineer a linear protocol.

### Lab-notebook compatibility checklist

Imported protocols become "calculators" inside lab-notebook entries via the existing V3.116 protocol-chip flow + V3.127 calculator panel. To make this work cleanly:

- Every `formula.output.name` should be **stable, unique, and snake_case**. The notebook calculator looks them up by name.
- The protocol's top-level `summary` should be a single sentence — it shows in the notebook chip's hover tooltip and on the calculator panel's header.
- Step bodies that reference variables should use `[!var:<name>]` tokens (NOT hardcoded numbers). The notebook calculator updates these chips live as the student adjusts the inputs.
- **Don't emit `[!inv:<id>]` tokens.** You don't know the lab's actual inventory ids; emit free_text only and let the page-side matcher link to inventory after import.

### Image extraction

Embedded images go in figure blocks as data URIs:

```json
{
  "kind": "figure",
  "body": "Caption text here.",
  "attrs": {
    "image_data_uri": "data:image/png;base64,iVBORw0KGgo...",
    "image_alt": "What the image shows",
    "width_pct": 100
  }
}
```

**Process for each format:**

- **`.md`**: For each `![alt](path)` reference, `Read` the file at `path`, encode as base64, build `data:image/<mime>;base64,<base64>`. The Read tool returns binary content for image files and Claude Code can natively encode it.
- **`.pdf`**:
  ```bash
  pdfimages -png /path/to/file.pdf /tmp/proto-img
  # produces /tmp/proto-img-000.png, -001.png, ...
  base64 -i /tmp/proto-img-000.png  # macOS / use base64 -w 0 on Linux
  ```
  Read the page text first to figure out which image goes with which step / caption (PDFs don't preserve image-to-text adjacency cleanly).
- **`.docx`**: After pandoc conversion (`pandoc file.docx -o /tmp/file.md --extract-media=/tmp/docx-media`), the images live at `/tmp/docx-media/media/*`. Encode each.

**Size limit**: 15 MB per image (Storage rule). If an image exceeds this, downsample first via `sips -Z 2000 input.png --out output.png` (macOS) or `convert -resize 2000x input.png output.png` (ImageMagick).

**If image extraction fails or you can't tell which image goes where**: emit the figure block with empty `image_data_uri: ""` and a placeholder caption like "[image to be uploaded — see source page N]". The user can upload manually post-import via the V3.113 figure UI.

## Validation before handoff

Before declaring the JSON ready, sanity-check it:

1. `format === "protocol-import-v1"`.
2. `protocol.title` is non-empty.
3. Every block has a `kind` from the closed list (unknown kinds import as plain steps — a warning, not fatal).
4. Every `formula` block has `attrs.expression`, `attrs.variables[]` (each with `name`/`label`/`default`), and `attrs.output.name`.
5. Every `callout` has a valid `attrs.type` (else it defaults to `note`).
6. Every `calculator` output has both `name` and `expr`; each `builder`/`layoutMap` names a `dataset` (a builder's dataset should match the `dataset` its calculator table / layout map reads).
7. Every `[!var:<name>]` token in any body references a name that exists in some formula/calculator/builder variable or output (or warn the user if not).
8. JSON parses cleanly (no trailing commas, no comments).
9. File size: a single image-heavy import can balloon. If the JSON is over 50 MB, warn the user — the upload UI will struggle.

## What you do NOT do

- **Don't** write to Firestore. Don't run `firebase ...` commands. Don't touch `rm/` files. The skill outputs a JSON file only.
- **Don't** guess inventory item ids. Always leave `item_ref: null` on materials rows.
- **Don't** invent variables for hardcoded constants. Only promote source numbers to formula variables when the source treats the number as a parameter (the user can adjust it).
- **Don't** emit `python` block kind, even if the source has Python code. That kind is reserved for a future Pyodide-backed phase. If the source has Python, embed it as a code-fenced `note` block body for now.

## Hand-off

Save the file as `<slug>.protocol-import.json` in the user's cwd. Tell them:

> Open `mcgheelab.com/rm/pages/protocols.html`, click **📥 Import protocol**, drop in the JSON file, pick a slug, click Import. After import, the page will offer to walk you through matching materials to your lab inventory.

That's it.
