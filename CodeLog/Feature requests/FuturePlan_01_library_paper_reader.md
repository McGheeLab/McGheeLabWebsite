# FuturePlan 01 — Library + Paper Reader Upgrade

> **Status: ✅ IMPLEMENTED (2026-07-11) as V3.308–V3.311.** Release 1 →
> `CodeLog/ClaudesPlan/V3.308_library_lookup_function.md`, Release 2 →
> `V3.309_library_metadata_editor.md`, Release 3 →
> `V3.310_citation_localization_refresh.md`, Release 4 →
> `V3.311_missing_pdf_queue.md`. Functions + rules deployed; awaiting FTP
> push of the client tree. Do NOT re-implement from this doc.
> **Origin:** wishlist roadmap session, 2026-07-11.
> **Ship order:** this was doc 01 of 05 — Library + paper reader shipped first.

> ⚠️ **Cross-reference — do this ops task NOW, regardless of this doc:** the Slack historical import (see `FuturePlan_05_ourlab_slack_mobile.md` → "Ops now") needs no code and may be racing a 90-day history expiry if the lab Slack is on a free plan. Check the Slack plan tier and run the import before or alongside this doc's work.

## Context

Wishlist items: *"when i load in a paper manually I have no way to edit the meta data for it, and i cant even put in a doi so it can auto update everything about the paper"* and *"paper reader needs a more robust way to look at citation flow in the paper most fail to show correctly in the left view"*, plus the rm/wishlist.md missing-PDF queue item.

What exploration found (2026-07-11):

- **DOI lookup is broken in production.** `rm/js/library-metadata.js` proxies lookups through dev-only `rm/server.py` endpoints (`/api/library/lookup` etc.). On mcgheelab.com there is no server — no Cloud Function equivalent exists — so add-by-DOI and ingest-time metadata sniffing silently fail. This is the foundation everything else depends on: fix it first.
- **No metadata-edit UI exists at all.** A failed lookup leaves `title=filename`, empty authors, `source:'manual'` forever, with no way to repair it.
- **The citation-flow problem is inline localization, not retrieval.** The reference *list* is already fetched correctly (Semantic Scholar/Crossref, cached at `items/{id}/details/main.references`). What fails is finding *where each reference is cited in the PDF body*: `rm/js/paper-citations.js` uses a token-scan-then-reverse-map approach (`_scanPage` + style-by-style sub-scanners around lines 44-60 and 504) that is inaccurate and misses markers across paper styles. User clarification (verbatim intent): use the papers already stored in the library as fixtures to debug and tune detection — the fix is reference-driven search, not better blind scanning.
- Library items live in the lab-scope `items` collection (`type=='paper'`, `meta.library.is_library_entry`); PDFs in Storage under `papers/{id}/{hash}.pdf`; annotations key off `item.id`, so ids and `citation_key` must never change implicitly.

## Locked decisions

- Title-search fallback everywhere an identifier lookup can dead-end (user request): PDF ingest with no DOI/PMID/arXiv on page 1, and full-refresh on identifier-less items, both fall back to a title query with one-click confirm (fuzzy → never silent-apply).
- Citation fix = invert detection: search the PDF for each *known* reference's expected marker forms, rather than scanning tokens and guessing.
- Build a citation-audit harness that runs the detector across the whole stored library and reports coverage — tune against real styles, not one paper at a time.

---

## Release 1 — Production metadata lookup (Cloud Function)

- **New `functions/library-lookup.js`:** `libraryLookup` onRequest function. Copy the CORS + Bearer-ID-token verification pattern from `functions/library.js` (the deletePaper pattern). Gate: `users/{uid}.role != 'guest'`. Body `{doi|pmid|arxiv_id|title}`; port `_lookup_crossref` / `_lookup_pubmed` / `_lookup_arxiv` / `_csl_to_unified` 1:1 from the dev `rm/server.py` (sibling ResearchManagement repo) so the response stays byte-compatible with `buildPaperItem`. CrossRef polite-pool User-Agent; Node 18 native fetch, no new deps. Register in `functions/index.js`.
- **Caching:** Firestore `metadataCache/{sha1(kind:key)}` docs `{kind, key, result, fetched_at}`, 30-day TTL, Admin-SDK-only (add an `allow read, write: if false;` block to firestore.rules). Title queries uncached.
- **`rm/js/library-metadata.js`:** `lookup()` branches on `RM_RUNTIME.isLocal` — local server.py path kept for dev, Cloud Function on prod, graceful fallback both ways. `extractFirstPage()` moves client-side via `PDF_VIEWER.extractTextItemsFromPdf` (already loaded on library.html).
- **Title-search fallback at ingest:** when a PDF ingest finds no DOI/PMID/arXiv on the first page, don't dead-end at `source:'manual'` — automatically run a `{title}` lookup (Crossref `bibliographic` query + Semantic Scholar title match) using the best title guess: PDF title metadata, else the largest first-page text run, else filename. Present the top hit for one-click accept (reuse Release 2's diff table once it exists; until then a simple confirm).
- **Deploy order:** functions → rules → FTP (+ sw.js CACHE_VERSION bump — check current value at implementation time).
- **Verify:** add-by-DOI works on prod; a second add of the same DOI hits the cache; PDF drag-drop sniffs the DOI (`source ≠ 'manual'`); guest gets 403; local dev path unchanged.

## Release 2 — Metadata editor + fetch-from-identifier diff

- **New `rm/js/library-edit.js`:** `LIBRARY_EDIT.open(item, {onSaved})` form modal — title, authors (one `Family, Given` per line), year, journal, volume/issue/pages, DOI/PMID/arXiv, URL, abstract (→ extras subdoc), tags. A **Fetch-from-identifier** button runs the Release-1 lookup and renders a per-field diff table (empty fields pre-checked, conflicts unchecked) → "Apply selected" → Save. Targeted single-doc write (`items/{id}.set`) — never rewrite the whole collection. `item.id`/`citation_key` never change implicitly (annotations key off id); opt-in "regenerate citation key" checkbox only.
- **`rm/js/library.js`:** ✎ edit button per row; "⚠ fix metadata" chip on `source:'manual'` / empty-author rows. **`rm/js/library-paper.js`:** "✎ Edit metadata" action in the reader sidebar's metadata block.
- **Rules change required** (firestore.rules items block, ~line 1053 at planning time): the current rule only lets admin/first-author update `type=='paper'` docs. Add a lab-member clause scoped to `meta.library.is_library_entry == true` with `request.resource.data.get('first_author_uids',[]) == resource.data.get('first_author_uids',[])` — use `.get(...,[])` because the key is usually absent on library entries. **Test with a non-admin account before FTPing the UI** — this is the one escalation-risk spot in the whole doc.
- Deploy: rules → FTP (+ CACHE_VERSION bump).

## Release 3 — DOI-driven full refresh + citation-flow robustness

- **New `rm/js/library-refresh.js`:** `fullRefresh(itemId, {doi, interactive})` = identifier lookup (DOI/PMID/arXiv, **else title-search fallback** on the item's stored title — same backstop as ingest, so a titled-but-identifier-less item can self-heal and even discover its DOI) → merge → Unpaywall OA PDF attempt (export the two existing helpers from `rm/js/library-upload.js` instead of duplicating; a CORS block stamps `pdf_candidate_url`) → `enrichItemFromSemanticScholar` → regex ref-parse fallback → summary toast. Sidebar "↻ Refresh from DOI" action in the reader.
- **`rm/js/paper-citations.js` — reference-driven inline localization (the core fix):**
  1. **Detect the paper's citation style once** — numeric-bracket `[12]`, numeric-paren `(12)`, superscript-numeric (Nature/Vancouver), author-year `(Smith et al., 2020)`, narrative `Smith and Jones (2020)` — by sampling the body text against the known reference count and the author/year set from stored refs.
  2. **Search the PDF for each known reference's expected marker forms** instead of guessing from tokens: numeric styles → that reference's index number in the detected bracket/paren/superscript context; author-year styles → first-author surname + year with `et al.` and `&`/`and` variants. We hold the authoritative ref (number, authors, year, title), so detection has a concrete target. Reuse the existing cluster-expansion (`_expandNumericInner`, ~line 377) and rect-location fallbacks (`_rectForRange*`, ~lines 404-458) for placing each hit.
  3. **"All refs (N)" tab** next to "This page" so the panel is never empty when refs exist; each row shows which pages its markers were located on.
  4. **Diagnostic card on failure** instead of an empty panel — names the reason ("references retrieved but no inline markers located — unrecognized citation style" / "no stored references — add a DOI") with actions: ↻ Re-detect, ⚡ Enrich from Semantic Scholar, ＋ Add DOI… (chains into fullRefresh). GROBID/server-side parsing stays out of scope (no prod server).
- **Citation-audit harness using the stored library as fixtures:** a dev page or mode (`rm/pages/citation-test.html` or `?citationAudit=1`) that runs the detector across all stored papers having a PDF + stored refs, reporting per-paper: style detected, % of references located with ≥1 inline marker, total markers placed. Admin-gated, read-only, no schema writes. This is how the detector gets tuned against the lab's real paper styles.
- FTP only (+ CACHE_VERSION bump).
- **Verify:** across stored papers spanning numeric, superscript, and author-year styles, the harness reports high located-marker coverage; opening each paper shows inline hovers at the correct citation points; a previously-empty panel now resolves; an unrecognized style surfaces the diagnostic card rather than silently wrong markers.

## Release 4 — Missing-PDF queue

- **`rm/js/library.js`:** `_pdfStatus(item)` = ok | missing | unobtainable; toolbar chip "Missing PDFs (N)" filtering the list; per-row actions: ↻ Retry (Unpaywall pipeline, stamps `pdf_retry{last_at, attempts, last_error}`), ⬆ Upload (same Storage path family `papers/{id}/{hash}.pdf`, then parse+enrich like `_ingestOne`), 🚫 Mark unobtainable (`pdf_status:'unobtainable'`, reversible).
- **`rm/js/library-paper.js`:** the reader's no-PDF dead-end gets the same three actions.
- New light fields on `meta.library` are covered by Release 2's rules clause. FTP only (+ CACHE_VERSION bump).

---

## Data model summary

- New `metadataCache/{sha1}` collection — Admin-SDK-only, rules-blocked (Release 1).
- New firestore.rules lab-member update clause on `items` scoped to `meta.library.is_library_entry == true` with unchanged `first_author_uids` (Release 2).
- New `meta.library` fields: `pdf_status`, `pdf_retry{...}`, `pdf_candidate_url` (Releases 3-4). No composite indexes expected.

## Release ritual (every release)

1. `CodeLog/ClaudesPlan/V{n}_{slug}.md` before implementation. 2. CHANGELOG + ARCHITECTURE updates + sw.js CACHE_VERSION bump. 3. Deploy order: **functions → rules → FTP**. 4. `python3 scripts/version_push.py`.

## Rollback

- Releases 2-4 are client-mostly: git revert + re-FTP + CACHE_VERSION bump.
- Release 2's rules clause is additive — revert the rules file + redeploy; old UI keeps working.
- Release 1's function: redeploy previous revision; client falls back gracefully (lookup just fails as it does today).

## Open questions

1. Confirm library items truly never carry `first_author_uids` (affects the `.get()` guard in Release 2's rules clause).
2. Exact Unpaywall email/key config for the prod pipeline (currently in the dev server path).

## Verification (end-to-end, after all releases)

On prod as a **non-admin member**: add a paper by DOI; rescue a `source:'manual'` item via editor + fetch-from-identifier; open papers across numeric / superscript / author-year styles and confirm inline citation markers land at the correct points; run the citation-audit harness over the stored library and check coverage; repair a no-DOI paper via the diagnostic card; work the missing-PDF queue (retry / upload / mark unobtainable).
