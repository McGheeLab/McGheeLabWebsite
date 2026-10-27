# scripts/scientia-project — a project spec → one Scientia project

`build-project.js` turns a content spec into a whole Scientia project and pushes it to a hub. It is the sibling of
`scripts/litreview/build-note.js`, which builds one literature-review note. The first project built with it is the PE-bead
assay (`Research/bead_confocal_scientia/project-spec.js`, V3.893); since V3.923 that work is one note inside Source and sink
(`plan-spec.js`).

```bash
node scripts/scientia-project/build-project.js <spec.js> --out records.json [--heights h.json]
     [--local http://127.0.0.1:PORT]          # a desktop serve.py notebook, for a render check
     [--cloud <uid> [--commit]]               # a person's cloud hub: dry run unless --commit
```

## What a spec holds

A CommonJS module exporting:

| Field | What |
|---|---|
| `slug`, `idTag`, `createdAt` | Fix every id and timestamp. A re-run updates the same records, and records of the project that the spec no longer has are removed. |
| `project`, `themes`, `aims` | `aims[].milestones[].weight` must sum to 1 (Scientia's grading rule). |
| `media` | `{ key: { file, name } }`: PNG figures, self-contained HTML pages (shown in Scientia's sandboxed frame), PDFs. |
| `library` | Citation keys → lab-library ids, for `[[cite:key]]` chips. The papers must already be in the lab library, which the hub mirrors. |
| `notes[]` | `{ key, type, themeId, title, synthesis, tags, columns, sections: [{ name, color, items }] }`. Each section becomes a region. Each item sits in a column (`col`), across columns (`span: [a, b]`), or across all of them (`col: 'full'`). |
| `wires[]` | `{ from: 'noteKey:itemKey', to, rel }`. These include wires between notes, which show on the Portfolio map. |
| `project.existing` (V3.923) | Build into a project the hub already has, such as an RM project the hub mirrors (`rm-p-…`). Its record is never written or removed. Give the spec its own `idTag`: re-runs remove only records carrying it. |
| `reviews[]` (V3.923) | `{ docId, addProjectIds, removeProjectIds }`. Re-link an existing literature review to this project by changing only its `review.projectIds` on the record the hub holds now. |

**Item kinds:**
- **`text`.** Supports `**bold**`, `*italic*`, `$math$` and `$$display$$` (MathLive), `[[cite:key]]`, `[[note:key|words]]`, and `• ` / `1. ` / `☐ ` lines. Add `struct: 'claim' | 'question' | 'decision' | 'barrier' | …` to make the first line a structure, recorded under the project so it shows on the project page.
- **`figure`.** An image grid with captions.
- **`html`.** Give it a size with `h` and `w`.
- **`eq`.** LaTeX plus a legend. The legend is keyed through Scientia's own TEX reader, so every term must have an entry.
- **`calc`.** A calculator. Wire equations to it with `rel: 'related', directed: false`.
- **`protocol`.** A registered protocol whose home is the note it is in, so put it in a `protocol`-type note. With `keep: true` (V3.923) it is kept in its note instead (Scientia's "kept in its note", `localOnly`): runnable where it sits, so one planning note can hold several procedures.
- **`plate`.**
- **`noteref`.** By note key, or by `docId` with an optional `focusId`.

A wire end written `'#<blockId>'` (V3.923) is a component of another note, such as a literature review's finding; it shows as a link at the foot of the card in this note.

**Note types:**
- `note`, `analysis` and `planning` are canvases.
- A `protocol` note numbers its components as steps (Gabe's template).
- **Do not use `resource`** for a document. Scientia shows it as a material sheet (lot, batch, stored at), not as a canvas.

## Layout

Boxes are placed from estimated heights. To place them from real heights, render once and measure:
1. Push to a scratch desktop notebook.
2. Open `scientia.html` in a persistent browser session *before* the push. A fresh browser's first sync replaces the server's record.
3. Measure every `.box[data-id]`, passing them as `--heights` in the format `{ blockId: [x, y, w, h], '_head:<docId>': h }`.
4. Build again.

The PE-bead project's render script is described in its README.

## Publishing

`--cloud <uid>` is a dry run. It prints what is new, what changed, what would be removed, the media to upload, and the cited papers missing from the hub's library mirror. Adding `--commit` uploads the media through `FirestoreHub.mediaPut`, pushes only the changed records, and refreshes the library mirror when a citation needs it. It writes to a person's hub, so run it only when that person asks.

## A shared project that disappeared (V3.931)

`node scripts/scientia-project/restore-share.js --name "<project name>"` is read only: it finds the project in every hub
(live rows, tombstones, the op log), prints the share index, each involved hub's `replacedAt`, its paired computers and the
copies kept before each replace, then the best surviving copy (the owner's kept copy → the share's shadows → the op logs)
and what the owner's hub lacks. `--commit` writes those records back to the owner as device "restore", with the grants on
the project, and runs the share pass so every member has their copy again.
