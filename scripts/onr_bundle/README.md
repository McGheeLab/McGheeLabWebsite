# `scripts/onr_bundle/` — the ONR technical volume → RM paper bundle

A three-stage, re-runnable pipeline that turns
`Data/Grants/ONR Technical Proposal.docx` into
`Data/Grants/onr-technical-proposal.paperbundle.zip`, which imports into the RM
Paper Builder as a fully editable grant draft.

```bash
STAGE=/tmp/onr-stage
python3 scripts/onr_bundle/extract_onr.py "Data/Grants/ONR Technical Proposal.docx" --out $STAGE
python3 scripts/onr_bundle/resolve_dois.py --stage $STAGE
python3 scripts/onr_bundle/build_onr_bundle.py --stage $STAGE --out /tmp/onr-work
python3 .claude/skills/paper-bundle/scripts/build_bundle.py /tmp/onr-work \
        --slug onr-technical-proposal --gen-md --strict
```

Then upload the zip via **📥 Import paper** on
`rm/pages/paper-builder.html`, and run `scripts/seed_onr_associations.js` to
wire the imported draft to the awarded grant card on the research map.

## Why three stages and not one pandoc call

`pandoc file.docx -o out.md` loses the three things that matter most here:

| What | Where it actually lives | What pandoc gives you |
|---|---|---|
| The 33 references | base64(zlib(JSON)) inside each citation field's `w:instrText` | the rendered number, `6` |
| The Gantt chart | `w:shd/@w:fill=FFC000` on empty cells | an empty table |
| Figure 4 | an anchored `w:drawing` *inside* a body paragraph | placed, but easy to miss with a naive walker |

So stage 1 reads `word/document.xml` directly for structure, citations, images
and table shading — and delegates only the maths to pandoc, whose OMML→LaTeX is
better than anything worth hand-writing. The 97 `m:oMath` elements align 1:1, in
document order, with the 97 `Math` nodes in pandoc's AST.

Stage 2 fills in the six references Paperpile carried with no DOI, by
**looking them up** on CrossRef and accepting only an exact normalized-title
match. Results cache to `doi_overrides.json`, so the build is deterministic and
works offline afterwards.

Stage 3 maps blocks onto the RM manifest and refuses to emit a bundle whose
census disagrees with the docx (5 figures, 9 equations, 2 tables, 33
references, 16 sections, every marker 1..33 used).

## The three lossy edges, named

1. **Heading depth.** The docx nests H1→H5; an RM `subheading` is level 2 or 3
   only. One level is *promoted*: every H2 under "Technical Approach" and every
   Aim becomes its own section, after which H4→2 and H5→3 fits exactly.
2. **The Gantt.** RM tables have no per-cell shading and no cell merging, so an
   amber cell becomes `●` and a `gridSpan=7` aim row becomes a label in column 0.
3. **Numbering.** The docx labels *both* tables "Table 1". Captions lose their
   literal `Fig. N.` / `Table N.` prefix and the prose references become
   `[!fig:…]` / `[!tab:…]` / `[!eqr:…]`, so RM numbers them — which incidentally
   fixes that collision.

## Verifying the maths

The editor renders inline maths with KaTeX 0.16 from jsDelivr, so that is what
to check against — not `pdflatex`:

```bash
curl -sSo /tmp/katex.js https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js
# then render every $…$ and every equation body with throwOnError
```

That check is what caught Word's Greek confusables (`\mu_{ο}` with U+03BF
omicron, `k_{Β}Τ` with Beta and Tau) and pandoc's trailing `\` before a closing
`$` — both of which `normalize_math()` in stage 1 now fixes.
