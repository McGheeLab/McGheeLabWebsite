# FuturePlan 07 — Paper builder upgrade: write content, not formatting

> **Status: ✅ COMPLETE — all 7 releases in the working tree.**
> 1→V3.334 (Writing Guide tab), 2→V3.341 (template infra + 4
> pure-TeXLive journals), 3→V3.343 (Nature/Science/PLOS/ACS),
> 4→V3.344 (editor citation styling + narrative [@*key]),
> 5→V3.345 (footnotes + add-ons + bibliography preview),
> 6→V3.346 (authors panel + auto-label + word badges + ⌨),
> 7→V3.347 (compile-service figure fetch; subcaption descoped —
> subfigures are panel labels on one composed image).
> Pending: FTP deploy + `gcloud run deploy` for the compile service
> (Release 7) + in-browser review pass.

## The idea

Students should write **content only**. They place citations, figure /
equation / table references, equations, and tables where they belong in
the prose, and the builder's infrastructure produces correct formatting
for **every major journal style** — document class, section conventions,
citation + bibliography style, figure placement — plus the useful LaTeX
add-ons (footnotes, units, chemistry, line numbers). A **Writing Guide
tab** teaches the student what the section they are writing should
contain, move by move, with live self-checks.

Decisions of record:

- Guide tab = **curated static guidance only** (no AI).
- Journal targets: **Nature, Science, PLOS, Elsevier (elsarticle), IEEE,
  ACS, generic preprint/bioRxiv (numeric + author-year)** in addition to
  the existing SLAS `mebp-journal`.
- Delivery = phased releases from this doc, one version each.

## Ground truth that re-scoped the plan (verified 2026-07-12)

1. **Cross-references are already live tokens.** `[!eqr:label]`,
   `[!fig:label[:panel]]`, `[!tab:label]` chips renumber live in the
   editor and export as `\ref`/`\eqref`. The actual gaps: (a) export
   drops the "Fig./Table/Eq." prefix so the PDF reads "as shown in 3";
   (b) unlabeled numbered floats dead-end in an alert inside the ref
   pickers (`paper-equations.js` ~L3600/3655).
2. **Template fetching is broken in production.**
   `api.load('paper-templates/<id>.json')`
   (`rm/js/paper-export-config.js:52`) has no route in `api-routes.js`
   → falls through to the dev-only legacy fetch; the JSON lives only in
   the sibling `ResearchManagement/data/` repo. On godaddy it 404s.
   Templates must move into this repo's FTP-deployed tree
   (`rm/data/paper-templates/`).
3. **Citation command is hardcoded** — `paragraphTextToTex` always emits
   `\cite{}` (`rm/js/paper-export-tex.js:401`); the template's
   `cite_command` / `citation_style` fields are never read. Editor
   citation chips always render "Author Year" regardless of journal.
4. **Tectonic has no biber** → all templates use BibTeX backends
   (`.bst`). The Cloud Run compile service already passes through
   arbitrary **text** bundle files, so journal `.bst`/`.sty` files can
   ship via a template `extra_files` array with zero service changes.
5. The compile service's figure fetch is still a stub
   (`functions/paper-compile/server.js` "TODO Phase 1.1") and
   `figureToTex` ignores `attrs.subfigures` — folded in as Release 7.
6. Paste is already plain-text-only; per-block comments exist
   (`section-comments.js`) — no work needed there.
7. Eight curated `training-paper-*.html` lecture pages shipped in
   V3.330 — the Guide tab links to them instead of duplicating content.

## Release roadmap

| Release | Scope | Touches |
|---|---|---|
| **V3.334 — Writing Guide tab** (✅ this release) | Section-aware curated guidance + live self-checks pill tab (`rm/js/paper-writing-guide.js`) | client JS/CSS |
| **V3.341 — Template infra + pure-TeXLive journals** (✅ shipped) | Static template hosting at `rm/data/paper-templates/`; template schema v2; migrate `mebp-journal`; ship `preprint-numeric`, `preprint-authoryear`, `ieee`, `elsevier`; grouped picker + per-journal limits lint. Also fixed 3 latent export bugs (fig cross-ref parse, markdown/LaTeX collision, table-caption citations) | client JS + data |
| **V3.343 — Embedded-file journals** (✅ shipped) | `nature`, `science`, `plos`, `acs`. Tectonic's bundle covers `naturemag.bst` + `achemso`; only `science` (`scicite.sty`+`Science.bst`) and `plos` (`plos2015.bst`) embed via `extra_files`. All nine templates compile to PDFs under local Tectonic | data + compile verification |
| **V3.344 — Citation style in the editor** (✅ shipped) | `paper-cite-style.js`: chips render per template `render_family` (superscript ¹ / [1] / (1) / (Smith, 2024)); `[@*key]` narrative token → `\citet`; live renumbering | client JS |
| **V3.345 — Footnotes + add-ons + bibliography preview** (✅ shipped) | `[^text]` footnote token → superscript † chip → `\footnote{}`; add-ons `siunitx`, `mhchem`, `endfloat`; live bibliography preview in References tab | client JS |
| **V3.346 — Authors & workflow polish** (✅ shipped) | Authors/affiliations panel with per-template author-block formats; auto-label numbered floats (kills the "no label yet" alert); word-count badges in section headers; ⌨ shortcuts popover | client JS |
| **V3.347 — Compile-service completion** (✅ shipped; subcaption descoped) | Figure fetch in `functions/paper-compile/server.js` (client sends `figureAssets` storage paths); subfigure export (`subcaption` blocks) so `[!fig:label:A]` refs resolve in the PDF | Cloud Run + client |

## Key designs

### Template schema v2 (Release 2; backward compatible — absent keys = today's behavior)

```jsonc
{
  "schema_version": 2, "id": "nature", "group": "Nature Portfolio",
  "extra_files": [{ "relpath": "naturemag.bst", "content": "…" }],
  "citation": { "command": "\\cite", "narrative_command": "\\citet",
                "render_family": "superscript", "bibliography_style": "naturemag" },
  "refs": { "figure": {"prefix": "Fig.~"}, "table": {"prefix": "Table~"},
            "equation": {"prefix": "Eq.~", "command": "\\eqref"} },
  "author_block": { "format": "superscript" },   // superscript | elsarticle | ieee | achemso
  "limits": { "abstract_words": 200, "body_words": 4500, "references": 50, "figures": 8 },
  "addon_defaults": ["lineno", "setspace-double"],
  "incompatible_addons": ["twocolumn"]
}
```

New `main_template` placeholders: `{{ABSTRACT}}`, `{{KEYWORDS}}`,
`{{AUTHOR_BLOCK}}` (first consumer: elsarticle frontmatter). Harden the
placeholder substitution to function-form `.replace()` so `$&`-style
sequences in preambles can't corrupt output. `fetchTemplate(id)` tries
`fetch('/rm/data/paper-templates/' + id + '.json')` first, falls back to
the legacy `api.load` dev path; validate `id` against `/^[\w-]+$/`.

### Per-journal template specs

All compile on Tectonic's TeXLive bundle. Publisher classes like
`nature.cls` are deliberately NOT used — approximate with `article` +
preamble; that is standard for submission anyway.

- `nature` — article 12pt double-spaced, `naturemag.bst` (embed),
  superscript numeric cites, unnumbered sections, Methods after main
  text; defaults `lineno` + `setspace-double`; limits: abstract 200,
  body 4500, refs 50, figs 8.
- `science` — article 12pt double-spaced, AAAS `Science.bst` +
  `scicite.sty` (embed, `_license` note; fallback natbib
  round-numbers), numeric-paren italic cites; abstract 125.
- `plos` — article 10pt, `plos2015.bst` (embed), numeric-bracket,
  unnumbered bold heads, `lineno` default.
- `elsevier` — `elsarticle [preprint,12pt]`, `elsarticle-num.bst`
  (bundled with class), `\citep`; frontmatter uses the new placeholders.
- `ieee` — `IEEEtran [journal]` two-column, `IEEEtran.bst`,
  `\columnwidth` figure default, `IEEEkeywords`; incompatible with the
  `twocolumn` add-on.
- `acs` — `achemso [journal=jacsat,manuscript=article]`, class-managed
  superscript cites, achemso author block; suggest `mhchem`.
- `preprint-numeric` / `preprint-authoryear` — article 11pt single
  column; `unsrtnat` square-numbers vs `plainnat` author-year
  (`\citep`/`\citet`); suggest `lineno`.

### Citation mapping (Releases 2 + 4)

`[@k1; @k2]` → `template.citation.command`. New `[@*key]` narrative
token (single key; written by a "narrative" checkbox in the citation
popover — students never type it) → `narrative_command`, collapsing to
the plain command in numeric styles. The `*` discriminator must be added
everywhere `[@` is scanned: editor tokenizer, chip serializer,
`collectCitationKeys`, `paragraphTextToTex`. Also extend
`collectCitationKeys` to table captions (pre-existing hole — the editor-
side `getCitedKeysInPaper` already scans them; export doesn't).

Editor live style (`rm/js/paper-cite-style.js`): loads
`paperExports/{paperId}.templateId` → template → caches
`render_family`; `renderCitationChip` consults it, falling back to the
current `shortLabel`. Numeric families number by first appearance
(document-order walk); chip-invalidation observer extended to re-render
on `[@` content changes so numbers stay live.

### Footnotes (Release 5)

Inline `[^text]` token — dialect-consistent, no Yjs schema change
(chosen over a footnote-library Y.Array for simplicity; footnotes are
short). Renders as superscript `†` chip with tooltip; click-to-edit via
the existing chip `data-src` round-trip machinery; toolbar "+ Note"
button. Export pass runs before the markdown/cite passes so
`[^see [@smith2024]]` exports as `\footnote{see \cite{smith2024}}`.

### Cross-ref export fix (Release 2)

Thread `template` into `paragraphTextToTex`; emit
`refs.figure.prefix + \ref{…}` etc. The `cleveref` add-on switches to
bare `\cref{}` and suppresses prefixes.

### Authors & affiliations (Release 6)

`paperExports/{paperId}.authors = [{name, affiliationIdx[], corresponding,
email}]` + `.affiliations[]`, edited in a new collapsible section of the
export workspace; `renderAuthorBlock(template, authors, fallback)` with
four generators keyed by `author_block.format`. No structured authors →
current lead-author block (no regression).

## Release 1 (V3.334) — Writing Guide tab

Plan of record:
[`CodeLog/ClaudesPlan/V3.334_paper_writing_guide.md`](../ClaudesPlan/V3.334_paper_writing_guide.md).

Summary: new leftmost "Guide" pill in the editor's tabbed side panel.
Section-aware — follows the writer's focus (📌 pin to freeze) and shows,
for the focused section kind: a one-line purpose, the 3–5 rhetorical
moves (click to expand guidance), **live self-checks** computed from the
paper tree (word counts vs `SECTION_STYLE.maxWords`, uncited claims in
intro/discussion, figure-first results, unlabeled numbered floats,
unreferenced floats, skeleton-without-prose), and collapsed pitfalls +
good-vs-weak example. Focused figure block → caption recipe. No focus →
paper-level checks. Footer links to the matching `training-paper-*.html`
lesson.
