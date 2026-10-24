# scripts/litreview — a hypothesis-driven literature review → a Scientia note (prototype)

The method is [FuturePlan 14](../../CodeLog/Feature%20requests/FuturePlan_14_literature_review_method.md). These are the
tools the first review was built with (V3.888, 2026-10-23). Review data — PDFs, spec, located quotes, built records —
lives OUTSIDE this public repo, one folder per review (`~/Documents/GitHub/LitReviews/<slug>/`); never commit PDFs here.

| Step | Tool | In → out |
|---|---|---|
| Resolve citations | `resolve.py titles.txt resolved.json` | one title per line → Europe PMC records (DOI, PMID, PMCID, authors, abstract) |
| Fetch PDFs | `fetchpdf.py resolved.json pdfs/` | PMC open data on AWS → OpenAlex locations → bioRxiv; each file checked to be a real PDF |
| Locate quotes | `locate_quotes.py spec.json quotes.json` | every quote matched word for word on a PDF page → page + highlight rectangles |
| Lab library | `rm-library-add.js spec.json --by <email> --out libids.json --manifest m.json [--commit]` | DOI-dedupe against RM `items`; new papers in `buildPaperItem` shape, PDF at `papers/{id}/{sha256[:16]}.pdf`, tag `litreview:<slug>` |
| Build + push the note | `build-note.js spec.json quotes.json libids.json --out records.json [--heights boxes.json] [--local URL] [--cloud UID [--commit]]` | Scientia records (note, PDFs, quotes, structures, wires, regions); `--local` = a `serve.py` notebook for checking, `--cloud` = the person's hub |
| Check the layout | `render/view.mjs`, `render/zoom.mjs`, `render/fit.mjs`, `render/overlaps.js` | with the browser-automation skill against a local `serve.py`: box heights, overlaps, screenshots |

Python needs `pip install pymupdf requests certifi`. Node scripts use the repo's `firebase-admin` and
`scripts/service-account.json` (git-ignored).

## Publishing a built review (the two writes that need a person's go-ahead)

From the review's folder (`~/Documents/GitHub/LitReviews/erk-mechanochemical-waves/build`), with this repo at `$REPO`:

```bash
REPO=~/Documents/GitHub/McGheeLabWebsite
ME=<your lab Google account email>; HUB_UID=<your users/{uid} id>   # the review folder's README has them filled in
# 1. papers → the lab library (dry run first; --commit writes; m.json records what to undo)
node $REPO/scripts/litreview/rm-library-add.js spec.json --by "$ME" --out libids.json --manifest library-manifest.json
node $REPO/scripts/litreview/rm-library-add.js spec.json --by "$ME" --out libids.json --manifest library-manifest.json --commit
# 2. the note → your Scientia (dry run first; --commit uploads the PDFs, pushes the records, refreshes the library mirror)
node $REPO/scripts/litreview/build-note.js spec.json quotes.json libids.json --heights boxes6.json --out records-final.json --cloud "$HUB_UID"
node $REPO/scripts/litreview/build-note.js spec.json quotes.json libids.json --heights boxes6.json --out records-final.json --cloud "$HUB_UID" --commit
```

Then open the Lab Notebook → Scientia → **Lit reviews** (V3.889) → *ERK waves as a mechanochemical relay — lit
review*, and link it to its projects in its first block (or pass `--projects id,id` to step 2 — Scientia project ids,
e.g. `rm-p-source-and-sink`). The note carries `review { topic, projectIds }`, which is what puts it in that tab. Re-running step 2 is
safe: ids and timestamps are fixed per spec, so it updates the same records and removes only records of this note
that the spec no longer has.

## Layout rules the builder follows (why the canvas looks the way it does)

Top band on the column grid (each verdict above its column) · one column per hypothesis link · each finding followed
by its papers · paper = region (PDF 616 px | quotes 340 px) · quote wires only inside a column · column gap = wire
corridor (Scientia loops a long vertical wire out by ≈ 0.75 × (34 + 0.2 × span)); the build prints the widest loop.
