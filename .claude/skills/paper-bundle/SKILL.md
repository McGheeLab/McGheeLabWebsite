---
name: paper-bundle
description: Author a portable `.paperbundle.zip` that imports faithfully into the McGhee Lab RM Paper Builder. Convert a manuscript or grant (markdown, LaTeX, Word, PDF, or described from scratch) into `paper.json` (section tree + config + references + assets) plus embedded image files, then validate and zip it. The user uploads it via the "📥 Import paper" button on `mcgheelab.com/rm/pages/paper-builder.html` and the paper appears in their list as a fully editable draft. Use when the user has a paper/grant in a non-RM format and wants it as an editable RM paper, or asks to "make a paper bundle", "import this manuscript into the paper builder", or "turn this draft into a .paperbundle.zip".
---

# /paper-bundle — author a `.paperbundle.zip` for the RM Paper Builder

This skill is the **authoring** half of RM's paper import/export flow. It does
NOT touch Firestore, Cloud Storage, or the live site. It produces a single
`<slug>.paperbundle.zip` in the user's working directory that they upload via
the **📥 Import paper** button on
[`mcgheelab.com/rm/pages/paper-builder.html`](https://mcgheelab.com/rm/pages/paper-builder.html).

The drop side is `rm/js/paper-builder.js` → `rm/js/paper-import-engine.js` →
`rm/js/paper-tree-build.js`. On upload the importer runs the **full**
materialization on the list page (a progress modal, no navigation): it builds
the Yjs section tree, uploads image bytes to Storage and re-points the figures,
routes grant PDFs to the Grant Docs store, writes the export config, imports
references into the lab library (rewriting numeric `[N]` markers to `[@key]`),
and restores comments. The finished paper then appears in the list to open.

> **Keep this format in sync** with `PaperExportBundle.serialize`
> (`rm/js/paper-export-bundle.js`, the exporter) and `PaperImportEngine.run` /
> `PaperTreeBuild.buildInto` (the importer). The exporter is the canonical
> shape; this skill hand-authors the same manifest.

## When to invoke

The user has a paper/grant outside RM and wants it as an editable RM draft:

- "Import this manuscript into the paper builder."
- "Turn `mebp-draft.md` (or `.tex`, `.docx`, `.pdf`) into a paper bundle."
- "Make a `.paperbundle.zip` from these sections."
- "Set up a new grant in RM from this NSF proposal PDF."

If the user instead wants **annotations on an already-imported paper**, that's
`/paper-overlay`. If they want a **protocol**, that's `/protocol-import`.

## Inputs you need

1. **Source** — path to a `.md` / `.tex` / `.docx` / `.pdf`, or a verbal
   description. If none exists, offer to draft the tree from scratch.
2. **Title** — from the source heading/filename; confirm if ambiguous.
3. **Paper type** — `journal` (default), `grant`, `editorial`, or
   `book-chapter`. Grants change which template + sections apply.
4. **Template** — the compile template. Default `mebp-journal` for journals;
   for grants pick `nih-r01`, `nih-r21`, `nsf-standard`, or `nsf-career`.
   `blank` = no assumptions.

## Source-format support

| Format | Read text | Extract images |
|---|---|---|
| `.md` | `Read` tool | `![alt](path)` → `Read` the local image, save bytes into `assets/` |
| `.tex` | `Read` tool | `\includegraphics{path}` → copy the graphic into `assets/` |
| `.docx` | `pandoc file.docx -o /tmp/p.md --extract-media=/tmp/media` (fallback: `unzip -p file.docx word/document.xml`) | images land in `/tmp/media/media/*` |
| `.pdf` | `Read` with `pages` for >10pp | `pdfimages -png file.pdf /tmp/img` → per-image files |

For `.tex`, also lift `\cite{key}` / numeric refs and the `.bib`/`\bibitem`
list into `references[]` (see **Citations**). For a grant PDF the whole file
usually goes in as a `grant_docs[]` attachment (see **Grants**), not as parsed
sections — ask which the user wants.

## Bundle anatomy — files in the `.zip`

```
<slug>.paperbundle.zip
├── paper.json        ← authoritative manifest (REQUIRED). Everything below.
├── paper.md          ← readable prose companion (optional; NOT parsed on import)
├── refs.bib          ← BibTeX (optional; readability only)
├── comments.json     ← review comments (optional; array, blockId-bound)
└── assets/
    ├── <hash>.png    ← REAL image bytes (not base64 in the manifest)
    └── <hash>.pdf    ← grant-doc PDFs
```

Only `paper.json` is required, and within it only `tree.sections` (an array)
is enforced — the importer rejects the bundle without it. Everything else is
optional but recommended. Assets are **real files** in the zip; `paper.json`'s
`assets[]` array only *indexes* them.

Author these files in a scratch working directory, then run the build script
(below) to validate and zip.

## `paper.json` — the manifest

Top level:

```jsonc
{
  "bundle_version": 1,
  "exported_at": "2026-07-21T00:00:00.000Z",   // ISO; informational
  "paper":   { /* row metadata — see below */ },
  "config":  { /* paperExports formatting doc — see below */ },
  "tree":    { "meta": { "title": "…" }, "sections": [ /* REQUIRED */ ] },
  "equation_library": [],   // reusable inline equations (optional)
  "figure_unplaced":  [],   // figure blocks not yet placed (optional)
  "table_unplaced":   [],   // table blocks not yet placed (optional)
  "references": [ /* unified-metadata refs → library (optional) */ ],
  "assets":     [ /* index of assets/ files (optional) */ ],
  "grant_docs": [ /* attached PDFs for grants (optional) */ ]
}
```

### `paper` — the `projects/{slug}` row

```jsonc
"paper": {
  "title": "A Minimal Example Manuscript",   // used for the row + slug
  "paper_type": "journal",                   // journal|grant|editorial|book-chapter
  "grant_subtype": null,
  "template_id": "mebp-journal",
  "target_journal": "Journal of Examples",
  "repo_path": "", "repo_org": "", "notes": ""
}
```

### `config` — the `paperExports/{slug}` doc (formatting)

Controls the LaTeX template and layout. All fields optional; omit the whole
object to accept `mebp-journal` defaults.

```jsonc
"config": {
  "templateId": "mebp-journal",   // mebp-journal|nih-r01|nih-r21|nsf-standard|nsf-career|blank
  "paperType": "journal",
  "addons": [], "overrides": {},
  "authors": [ { "name": "Alex McGhee", "affiliationIdx": 0, "corresponding": true, "email": "…" } ],
  "affiliations": [ "Department …, University of Arizona, Tucson, AZ, USA" ],
  "buildTarget": "submission",    // submission|preprint
  "sectionNumbering": "auto",     // auto|on|off
  "graphicalAbstract": null       // {storage_path,…} → needs a matching assets[] entry
}
```

### `tree.sections[]` — the manuscript body

Each section: `{ id, kind, label, order, status, children: [block] }`.

- **`id`** — stable, unique (e.g. `sec-abs0001`). Comments re-bind by id; keep
  them stable if you re-export. Auto-generated if omitted.
- **`kind`** — from the closed **section-kind** list (below). Unknown → coerced
  to `custom` on import.
- **`label`** — display heading.
- **`order`** — integer; sections sort by it.
- **`children`** — ordered block list.

**Section kinds** (closed):
`abstract`, `keywords`, `introduction`, `background`, `methods`, `results`,
`discussion`, `conclusions`, `acknowledgements`, `references`, and the escape
hatch `custom`. Submission docs: `cover_letter`, `suggested_reviewers`,
`rebuttal`. Grant attached-docs (see **Grants**): `project_summary`,
`specific_aims`, `research_strategy`, `biosketch`, `facilities`, `budget`,
`budget_justification`, `current_pending`, `collaborators_coa`,
`synergistic_activities`, `data_management_plan`, `mentoring_plan`,
`resource_sharing`, `vertebrate_animals`, `human_subjects`, `select_agents`,
`letters_of_support`, `pecase_statement`.

> A `references` section should be present (empty `children: []`) so the
> bibliography renders there; the entries come from `references[]`, not from
> child blocks.

## Block kinds

Every block is `{ id, kind, status, body, attrs }` (paragraphs also carry
`skeleton_items`). `status` ∈ `draft|needs-review|complete`. Closed **block
kinds**: `paragraph`, `subheading`, `equation`, `figure`, `table`, `list`.
Unknown kinds import as `paragraph`.

`body` prose supports inline `$math$`, `[@citekey]` and `[N]` citations,
`**bold**`, and cross-references — see **Inline vocabulary** below.

### `paragraph`

```jsonc
{
  "id": "p-abs0001", "kind": "paragraph", "status": "draft",
  "skeleton_items": [
    { "id": "sk-1", "depth": 0, "text": "one-line point for this paragraph", "claim_id": null }
  ],
  "body": "The full paragraph prose. Cite prior work [1] inline.",
  "attrs": {}
}
```

`skeleton_items` is the paragraph's outline (depth 0–3). Optional but nice —
seed one depth-0 bullet summarizing the paragraph. `claim_id` stays `null`.

### `subheading` — flows inside a section (LaTeX `\subsection`)

```jsonc
{ "id": "p-h1", "kind": "subheading", "body": "Scope", "attrs": { "level": 2 } }
```
`level` 2 = subsection, 3 = subsubsection. `body` = heading text.

### `list`

```jsonc
{ "id": "p-l1", "kind": "list",
  "body": "first item\nsecond item\n  nested by two spaces",
  "attrs": { "list_type": "number" } }   // number|bullet
```
One item per line; two leading spaces per nesting level.

### `equation` — numbered display equation

```jsonc
{ "id": "p-e1", "kind": "equation", "body": "E = mc^2",
  "attrs": { "display": true, "numbered": true, "label": "key", "span": "column" } }
```
`body` = LaTeX (no `$…$` delimiters). `label` lets `[!eqr:key]` reference it.
For small in-prose equations, put `$…$` directly in a paragraph body instead.

### `figure`

```jsonc
{ "id": "p-f1", "kind": "figure", "body": "Caption text (supports $math$, [@cite]).",
  "attrs": {
    "storage_path": "imports/mypaper/fig1.png",   // MUST match an assets[] entry
    "download_url": "", "hash": "fig1", "mime": "image/png",
    "width": "\\linewidth", "placement": "H", "centering": true,
    "label": "overview", "alt": "what the image shows",
    "numbered": true, "subfigures": [],
    "anchor": "flow", "span": "column", "lock": false
  } }
```

- **`storage_path`** is the linchpin: it must equal an `assets[]` entry's
  `storage_path_original`, and that asset file must be in `assets/`. On import
  the bytes upload to Storage and the pointer is re-written. No match → the
  figure imports blank.
- `label` drives `[!fig:label]` references. Multi-panel: add
  `subfigures: [{ "id": "sf-a", "label": "A" }, …]` and reference `[!fig:label:A]`.
- Leave `download_url`/`hash` as shown; the importer re-mints them.

### `table`

Tables use Yjs shared types, so cells and caption use the `{__ytype}` wire
form **exactly** — a plain object drops the data silently.

```jsonc
{ "id": "p-t1", "kind": "table", "body": "",
  "attrs": {
    "rows": 2, "cols": 2,
    "cells": {
      "__ytype": "map",
      "entries": {
        "0-0": { "__ytype": "text", "value": "Header A" },
        "0-1": { "__ytype": "text", "value": "Header B" },
        "1-0": { "__ytype": "text", "value": "cell" },
        "1-1": { "__ytype": "text", "value": "42" }
      }
    },
    "caption": { "__ytype": "text", "value": "Table caption." },
    "numbered": true, "label": "summary",
    "booktabs": true, "header_row": true,
    "align": "lc",                    // one char per column: l|c|r
    "anchor": "flow", "span": "column", "lock": false
  } }
```

- Cell keys are `"<row>-<col>"`, 0-indexed; provide every cell you want
  populated (`rows`×`cols` grid).
- `caption` lives in `attrs` as `{__ytype:"text"}` (NOT in `body`).
- `align` has one of `l`/`c`/`r` per column.

## Citations

The import engine reads **`references[]`** (an array), materializes each into
the lab library, assigns collision-safe `[@citekey]`s, and **rewrites numeric
`[N]` markers in body text to `[@key]`** by 1-based order. This is the robust
path — you don't have to know the generated keys.

1. Put `references[]` in **citation order**, each in "unified metadata" shape:

```jsonc
"references": [
  { "title": "…", "authors": [ { "family": "Doe", "given": "Jane" } ],
    "year": "2024", "journal": "…", "volume": "12", "issue": "3",
    "pages": "101-115", "doi": "10.1000/x", "url": "https://doi.org/10.1000/x",
    "pmid": "", "arxiv_id": "", "abstract": "", "source": "manual" }
]
```

2. In `body` text, cite with numeric markers: `[1]`, `[2]`, `[1,3]`, `[2-4]`.
   The engine turns `[1,3]` into `[@keyA; @keyC]`, etc.

Notes:
- Provide as much metadata as you have — `title` + first-author `family` +
  `year` produce a good citation key. Bare DOIs work but yield weaker keys.
- After import, RM enriches each new reference from Semantic Scholar
  (abstract, reference list) in the background — you don't supply those.
- **Alternative:** if the references are already in the user's library, you can
  write `[@existingkey]` directly in bodies and skip `references[]`. But for a
  portable bundle, numeric markers + `references[]` is preferred.
- `refs.bib` in the zip is for human readability only; it is not parsed.

## Inline vocabulary (in any `body` / caption)

| Token | Renders as |
|---|---|
| `[1]`, `[2-4]`, `[1,3]` | numeric citation → rewritten to `[@key]` on import |
| `[@citekey]` | direct citation (must resolve in the library) |
| `$ … $` | inline math (LaTeX) |
| `**bold**` | bold |
| `[!fig:label]` | reference to a figure with that `attrs.label` |
| `[!fig:label:A]` | reference to subfigure panel A |
| `[!tab:label]` | reference to a table with that `attrs.label` |
| `[!eqr:label]` | reference to a numbered display equation |
| `[!eqi:id]` | insert an inline equation from `equation_library` by its `id` |
| `[!sec:ref_label]` | cross-reference to a section (set `ref_label` on it) |

## Grants (advanced)

For `paper_type: "grant"`, the NIH/NSF **attached documents** (biosketch,
budget, facilities, data-management plan, letters, …) are usually pre-made PDFs.
Route them to the Grant Docs store, NOT the section tree, via `grant_docs[]`:

```jsonc
"grant_docs": [
  { "kind": "biosketch", "label": "Biographical Sketch",
    "filename": "biosketch.pdf", "size_bytes": 220143,
    "storage_path_original": "imports/mygrant/biosketch.pdf" }
]
```
Each `kind` must be a grant attached-doc kind (see the section-kinds list), and
each needs a matching `assets[]` entry (with `ext: "pdf"`) whose file is in
`assets/`. The narrative (Specific Aims, Research Strategy / Project
Description) stays as normal `specific_aims` / `research_strategy` / `custom`
sections written as prose with `subheading` blocks.

## Assets (`assets[]`)

Index every image/PDF the manifest points at:

```jsonc
"assets": [
  { "hash": "fig1", "ext": "png",
    "storage_path_original": "imports/mypaper/fig1.png",
    "relpath": "assets/fig1.png" }
]
```
- `relpath` must be `assets/<hash>.<ext>` and the file must exist there.
- `storage_path_original` must match the referencing block's
  `attrs.storage_path` (figures), `config.graphicalAbstract.storage_path`, or
  `grant_docs[].storage_path_original`.
- Invent any stable `storage_path_original` (e.g. `imports/<slug>/fig1.png`);
  it's just a join key inside the bundle.
- Size limit 15 MB/image (Storage rule). Downsample large images first:
  `sips -Z 2000 in.png --out out.png` (macOS) or `convert -resize 2000x in.png out.png`.

## Comments (advanced)

`comments.json` is an array of review comments, each anchored to a block `id`:

```jsonc
[ { "id": "c1", "blockId": "p-abs0001", "body": "Tighten this claim.",
    "authorUid": "", "authorName": "Reviewer", "resolved": false,
    "createdAt": 1721520000000, "modifiedAt": null } ]
```
`blockId` must match a block/section `id` in the tree. Restore is best-effort
and health-gated on a Cloud Function (`restorePaperComments`) — if it isn't
deployed, comments are skipped without failing the import. Emit `[]` (or omit
the file) when there are none.

## Build + validate

Use the bundled script. It mirrors the closed vocabularies and catches the
silent-coercion traps (bad table cells, unknown kinds, missing asset files,
out-of-range citation markers, duplicate ids) BEFORE upload:

```bash
python3 .claude/skills/paper-bundle/scripts/build_bundle.py <workdir> \
        [-o out.zip] [--slug my-slug] [--gen-md] [--strict] [--validate-only]
```

- `<workdir>` holds `paper.json` (+ `assets/`, optional `paper.md`, `refs.bib`,
  `comments.json`).
- `--validate-only` reports without zipping. `--strict` fails on warnings too.
- `--gen-md` (re)generates a readable `paper.md` from the manifest.
- Output defaults to `<slug>.paperbundle.zip` in the cwd.

A clean run prints `0 error(s), 0 warning(s)`. Errors block the build; fix them.
Warnings are things the importer tolerates but you probably want to know.

There is a filled reference manifest at
[`reference/paper.example.json`](reference/paper.example.json) — copy it as a
starting point.

## Validation checklist (before hand-off)

1. `paper.json` parses; `tree.sections` is an array (**hard requirement**).
2. Every section `kind` and block `kind` is from the closed lists (else
   coerced — usually not what you want).
3. Every `figure.attrs.storage_path` (and grant-doc / graphical-abstract
   pointer) has a matching `assets[]` entry, and that file is in `assets/`.
4. Table `cells` is `{__ytype:"map", entries:{"r-c":{__ytype:"text",value}}}`
   and `caption` is `{__ytype:"text"}`.
5. `references[]` is in citation order; the largest `[N]` in any body ≤
   `references.length`.
6. Section/block ids are unique (comments bind by id).
7. `config.templateId` matches the paper type.
8. The build script exits `0`.

## What you do NOT do

- **Don't** write to Firestore/Storage, run `firebase`, or edit `rm/` files.
- **Don't** base64-embed images inside `paper.json` — put real files in
  `assets/` and index them in `assets[]`.
- **Don't** fabricate reference metadata; leave fields blank rather than invent
  DOIs/authors. Enrichment fills gaps post-import.
- **Don't** guess citation keys; use numeric `[N]` markers + `references[]`.
- **Don't** parse a grant PDF into sections unless the user asks — attach it as
  a `grant_docs[]` PDF.

## Hand-off

Save `<slug>.paperbundle.zip` in the user's cwd and tell them:

> Open `mcgheelab.com/rm/pages/paper-builder.html`, click **📥 Import paper**,
> and drop in the `.paperbundle.zip`. A progress modal runs the import
> (sections → figures → references → comments); when it finishes, the paper
> appears in your list — click it to open in the editor.
