# FuturePlan 14 — Hypothesis-driven literature review → a Scientia note

> **Status: method + working prototype (2026-10-23), not built into the app.** First run: *ERK waves as a
> mechanochemical relay* (35 papers, 28 PDFs on the canvas, 65 located quotes). Report:
> [Research/ERK_mechanochemical_waves_litreview.md](../../Research/ERK_mechanochemical_waves_litreview.md).
> Tooling: [scripts/litreview/](../../scripts/litreview/README.md). Review data (PDFs, spec, records — kept out of
> git): `~/Documents/GitHub/LitReviews/erk-mechanochemical-waves/`. Version entry: V3.888.

## Why

Alex (2026-10-23): investigate a mechanism ("does a RAS–ERK pulse set off a mechanical chain reaction?"), build it
"so it can be made into a Scientia note overview, pull papers and paper quotes, make connections", with "the PDF of
the paper right in the note canvas", laid out for a human to read — "and formalize the best way to do a literature
review this way … we will implement this as a method later". This file is that formalization. It extends the
V3.832 *Lit review mode* idea ([V3.832 plan](../ClaudesPlan/V3.832_scientia_integration_plan.md)) and the V3.859
Collection card, but lands in Scientia, which is where notes live since the unification (V3.866).

## The method — nine stages

1. **Frame the hypothesis as lettered links before searching.** Each link (H1a…d, H2, H3) is something that can be
   supported, contradicted or untested *on its own*; one verdict for a whole idea hides which part failed. Write
   down what would refute each link.
2. **Search to test, not to confirm.** Run the deep-research workflow (5 angles → sources → claims → 3 independent
   verifiers per claim) with an explicit instruction to report contradiction and quantities, and to tag
   measured / inferred / modelled. An agent handed a hypothesis tends to return it confirmed; the strongest output
   of the first run came from contradictions (H1 turned out inverted).
3. **Resolve every citation against a database.** Europe PMC REST (`TITLE:"…"`, `resultType=core`) gives DOI, PMID,
   PMCID, authors, abstract. DOIs never come from memory. Prefer the peer-reviewed record; keep the preprint DOI
   for the PDF. Dedupe against the lab library by DOI (2 of 35 were already there, with PDFs).
4. **Acquire PDFs through a fixed cascade, and validate them.**
   1. PMC Article Datasets on AWS (`pmc-oa-opendata`: `metadata/PMCxxxx.N.json` → `pdf_url`) — the reliable route
      for the PMC open-access subset. Some author manuscripts have a PDF there, many have text/XML only (licence TDM).
   2. OpenAlex `locations[].pdf_url` (repositories, bioRxiv copies of published papers).
   3. bioRxiv API `pubs/{server}/{published DOI}` → preprint → `…vN.full.pdf`; arXiv for physics.
   4. Europe PMC `?pdf=render` answers 403 to scripts; NCBI `oa.fcgi` has moved. **PMC's own PDF links sit behind a
      browser check — do not automate around it** (the auto-mode classifier blocked it, rightly). What is left goes
      to RM's own *Find PDF* (server fetch) or a person's Upload.
   5. Validate: `%PDF` magic, opens, ≥ 2 pages, has a text layer. Recompress images over ~15 MB (PyMuPDF
      `rewrite_images`, 130 dpi) — 38 MB → 2.3 MB, text layer untouched, so quote positions stay valid; the hub
      refuses media over 30 MB and phones choke on big PDFs.
   6. Label the version on the card: *preprint PDF*, *author manuscript PDF* (wording and page numbers differ from
      the journal).
5. **Re-verify against the full text.** All 8 claims the verifiers "refuted" in the first run were verifiers that
   could not open the article (403s); 5 of them were verbatim in the PDFs we had. Verification without full text
   produces false refutations — re-check failed claims in the PDF before dropping them, and keep "checked and
   failed" visible. Read numbers off the rendered page: text extraction mangles units (eLife's "μm min⁻¹" came out
   as "mm min 1"; an old EMBO J font renders "fi" as "®" and "–" as "±").
6. **Quote verbatim, and locate every quote.** A quote enters the note only if its letters and digits are found as
   one stream on a page of the PDF (so hyphens, dashes and the PDF's word splits don't matter); a pure number the
   quote doesn't have — a preprint's margin line number — is stepped over and not highlighted. Store page +
   per-line rectangles as page fractions: that is Scientia's quote component (`quote {src, page, exact, prefix,
   suffix, rects}`), so the passage is highlighted on the PDF and "from …" jumps to it. The text shown is the typed
   quote (verbatim, line-break hyphens rejoined); the page's own words are kept to check it.
7. **Synthesize in fixed card types.** Verdict per link (a *claim* with a stance: supported / contested), findings
   (claim + bullets + a **Basis:** line — measured / inferred / modelled, and the timescale regime: an acute
   minutes-long pulse and a weeks-long adaptation can give opposite answers), the revised model, a numbers card
   (every number with its source), gaps → experiments (for our lab: TFM + live ERK imaging), and how-it-was-built.
   Citation chips (`cite` marks → library rows) everywhere a paper is named.
8. **Lay the canvas out for a reader (rules that came from looking at renders).**
   - Top band on the same grid as the columns, so each column's verdict sits directly above it; head + synthesis
     above the band.
   - One column per link; inside it, each finding is followed directly by the papers that support or contradict
     it (claim → evidence reads top-down, wires stay short).
   - A paper = a region (named "Author Year — Journal", column colour): PDF 616 px wide on the left (opens at the
     abstract page), quotes 340 px wide on the right.
   - **Wires:** quote → its PDF (`c:quotes`, as Gabe's QUOTE.make does) and quote → findings *in the same column*
     only. No finding → column-header wires and no cross-column quote wires: in a tall column they are drawn
     straight across every PDF in between. Cross-column links stay as citation chips plus "(quotes in the Hino 2020
     region, H2 column)".
   - **Corridors:** Scientia loops a wire between stacked boxes out to the right by ≈ 0.75 × (34 + 0.2 × its
     vertical span + 3 per stacked end) (`scientia/src/12b-wires.js` `curve`). Size the gap between columns to the
     longest loop (640 px for a 6-paper group), and order papers so a paper sits next to every finding its quotes
     support. `build-note.js` prints the widest loop and warns when one leaves its corridor.
   - **Measure, don't guess:** render the note in the real app, read every `.box[data-id]` height, re-lay out,
     render again; check 0 overlaps and DOM position = spec position for every box. Then look at it at ~100 %.
9. **Publish (two writes that need the person's go-ahead).**
   - Papers → the lab library, the way RM's importer writes them (`buildPaperItem` shape, PDF at
     `papers/{id}/{sha256[:16]}.pdf`, tag `litreview:<slug>`, manifest for undo). The hub mirrors the library into
     every person's Scientia, so cites resolve and the PDFs open in RM's reader too.
   - The note → the person's Scientia hub through `FirestoreHub.push` (the protocol Gabe's devices use; deterministic
     ids and a fixed creation time, so a re-run updates in place and removes only records of this note that the
     spec dropped), PDFs via `mediaPut`, then a forced library mirror.
   In auto mode both writes were refused by the safety classifier (production writes with the service account) —
   correct for an unattended session; they are one-line commands for Alex (see the tooling README).

## Record mapping (Scientia)

| Thing on the canvas | Record | Notes |
|---|---|---|
| The note | `documents` `type: 'literature'` (scope global), `citeMode: 'author'`, `regions[]`, `layout.head/synth`, `synthesis.text` | header tags = the review's keywords |
| Text card | `blocks` `kind: 'component'`, `body {text, marks}` | marks: `fmt` (b/i), `cite` (OBJ char → library id), `struct` |
| Verdict / finding / gap | the card's first line marked with a `struct` → `items` `claim` (stance) / `question` (open) / `takeaway` | shows in Gabe's claims & lens |
| PDF | `media {kind:'pdf', path:'images/<id>.pdf'}` + `blocks {kind:'pdf', media, w:616, h, view:'scroll', cur, pages}` | the app fills the text for search on first open |
| Quote | `blocks {quote:{src, kind:'pdf', page, exact, prefix, suffix, rects, file}}` + `items` `evidence` with `sourceRef {type:'embed', page, selector}` | wired `c:quotes` to its PDF |
| Connection | `wires {from, to, rel}` — `supports` / `contradicts` / `comments` / `leads` | colours by relation |
| Paper in the library | RM `items/{id}` `meta.library` → hub `library` row (`rm: true`) | cites point at these |

## Lessons from the first run (keep)

- The local check rig: Gabe's `serve.py` on a spare port + a fresh notebook folder + the desktop build in a headless
  browser speaks the same push protocol as the cloud hub. **A browser origin keeps its IndexedDB:** reopening a
  changed notebook in the same origin shows the stale copy (and once replaced the server's record with it) — use a
  fresh origin per check (copy the folder, new port, or `127.0.0.1` vs `localhost`).
- In the app, a wheel over a card scrolls the card (a PDF eats it); zoom and pan from bare paper.
- A note with 28 PDFs needs ~10 s after load before `#/doc/<id>` resolves on a fresh device.
- `FirestoreHub` must be driven with the `firebase-admin` copy in `functions/node_modules` (the one the hub module
  requires), or it has no app.
- The hub to publish to is the person's: `uid` = their `users/{uid}` doc (the lab Google account).

## What to build (when Alex moves this into production)

- **R1 — a supported CLI.** `scripts/litreview` as is, plus `new <slug>` (scaffold a spec), one `run` that does
  stages 3–8, and the spec format documented (cards, lanes → groups → papers, quotes with targets).
- **R2 — in the app, no service account.** A *Lit review…* action (Scientia web + RM library) that takes a spec, runs
  stages 3–4 server-side (Europe PMC + the existing `fetch-paper-pdf` / `paper-pdf-fetch` functions), adds papers
  through the library importer, and writes the note through the hub's own `api/sync/push` as the signed-in person.
- **R3 — terms as the connection map.** Create the review's key terms (ERK wave, ADAM17, EGFR, ROCK, retrograde
  flow…) so Gabe's term scanner marks them in every note and the lens links this review to experiments. Terms are
  project-scoped: needs the scope decision below.
- **R4 — findings as Collections.** Each finding ↔ an RM Collection (V3.859) so the figure board and paper builder
  can pull a finding with its evidence and cite it.
- **R5 — a quote check view.** Every quote shown with its page crop and highlight before it is accepted; the
  "refuted in verification" claims listed with their vote and the re-check result.

## Decisions owed by Alex

1. Should a review add its papers to the lab library by default (tagged `litreview:<slug>`, undoable)?
2. Where review notes live: the person's own Scientia (this run) or under an RM project with *Seen by: lab members*.
3. Terms scope for reviews (a "Literature" project per person, or the lab's theme).
4. Preprint/author-manuscript PDFs on the canvas when the journal version is closed: keep (labelled) or skip.
