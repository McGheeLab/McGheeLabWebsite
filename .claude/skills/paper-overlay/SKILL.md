---
name: paper-overlay
description: Author a `.paper-overlay.md` file Claude can drop into the McGhee Lab RM paper reader to materialize highlights and comments scoped to a project bucket. Use when the user is doing a literature pass on a specific paper for a specific review task (GELS, MEBP, etc.) inside a sibling VSCode repo and wants annotations to appear on `mcgheelab.com/rm/pages/library-paper.html?id=...`.
---

# /paper-overlay — author a paper-overlay markdown file for RM

This skill is the *authoring* half of RM's paper-overlay flow. It does NOT touch Firestore or the live RM site. It produces a single `.paper-overlay.md` file in the user's current working directory that the user later drag-drops onto the paper reader at `mcgheelab.com/rm/pages/library-paper.html?id=<paper-id>`.

The drop side of the flow is implemented in `rm/js/paper-overlay-import.js` (parser + validator + preview modal + Firestore writes). Keep this file's format in sync with that parser.

## When to invoke

The user is in a literature-review session inside a sibling repo (e.g. `Prostate GELS Proposal/`, `MEBP-Paper/research/literature/`, `MRI Proposal/paper/`) and asks something like:

- "Make me an overlay for this paper relevant to GELS aim 2"
- "Pull the methods quotes I'd cite for the MEBP paper"
- "Generate a `.paper-overlay.md` for this PDF for the X review task"

## Inputs you need

1. **Paper identity** — either the RM paper id (kebab-case slug, e.g. `smith2024-gels-microfluidic`) or the DOI. If the user only has a PDF path, ask before guessing.
2. **Scope id** — what review-task the highlights belong to. **Three flavors of scope**:
   - **Paper-draft id** (`draft_id:`) — the paper-builder draft id. Visible in the paper-builder URL (`?paper=<id>`).
   - **Grant-draft id** (`grant:`, V3.187+) — the grant writer's grantDrafts/{id}. Visible in the grant-builder URL (`?grant=<id>`). When you're inside a sibling grant repo (e.g. `Prostate GELS Proposal/`, `MEBP-Paper/`), this is the natural scope.
   - **Legacy bucket id** (`bucket_id:`) — pre-V3.103 project-bucket; only emit if the user explicitly asks.
   The user may say "GELS R01" or "MEBP" — ask for the explicit id if you don't know it. The importer auto-tags the open library paper with this id (writes `meta.library.linked_drafts: arrayUnion(<id>)`).
3. **Paper text** — the PDF content. If you don't have it cached, ask the user to share the PDF or the extracted text. Quotes in the overlay must appear verbatim in the paper text or RM's importer will flag them as unmatched.
4. **Topic / lens** — what the user is reviewing the paper *for*. The whole point of the overlay system is that the same paper carries different highlight sets for different review tasks. Ask if it's not obvious.

## Output: `<slug>.paper-overlay.md` in the cwd

```markdown
---
paper_id: smith2024-gels-microfluidic
grant: prostate-gels-r01           # V3.187 — grant scope (alias for draft_id)
overlay_title: GELS aim 2 — relevance pass
created_by: claude
created_at: YYYY-MM-DD
---

## Highlight
page: 3
quote: "the storage modulus exceeded 10 kPa within 30 seconds"
type: evidence
color: green
comment: |
  Directly supports our claim that the gel sets fast enough for in-clinic use.
  Compare to our prelim data (Fig 4 in our draft).
evidence_stance: for

## Highlight
page: 5
quote: "however, batch-to-batch CV was 18%"
type: limitation
color: red
comment: Counter-evidence — we'll need to address reproducibility in the proposal.
evidence_stance: against

## Highlight
page: 7
quote: "we cured PDMS at 60 °C for 4 h"
type: method
comment: Same cure schedule we use; cite when describing our protocol.
```

## Format rules (must stay in sync with `rm/js/paper-overlay-import.js`)

- **Frontmatter** (between `---` fences):
  - `paper_id` OR `paper_doi` — at least one required.
  - **Scope id** — `grant: <grantId>` (V3.187+, when scoping to a grant draft) OR `draft_id: <paperDraftId>` (paper builder draft) OR legacy `bucket_id: proj-...`. All three resolve to the same internal `draft_id`; pick the one that matches what the user's working on. Omit only if you want a "general" highlight that renders regardless of overlay.
  - `overlay_title`, `created_by`, `created_at` — informational; not stored.
- **Each highlight block** starts with `## Highlight`. Required fields:
  - `page` — 1-based integer.
  - `quote` — verbatim text from the paper. Whitespace is normalized at import time, but content must match. Wrap in double quotes if it contains a colon.
- **Optional per-highlight fields:**
  - `type` (V3.188+) — closed enum, one of: `evidence` · `method` · `result` · `limitation` · `claim` · `note` · `question`. Defaults to `note`. The paper reader colors highlights by type and offers per-type filter pills. Pick the type that best matches the function of the quote in the user's review:
    - `evidence` — supports a claim/aim. Pair with `evidence_stance: for`.
    - `method` — a technique you'd use or cite when describing methods.
    - `result` — a specific finding to cite.
    - `limitation` — a gap or problem the paper acknowledges (gold for Significance/Innovation framing). Pair with `evidence_stance: against` if used as counter-evidence.
    - `claim` — a claim the paper makes that you want to track.
    - `note` — generic comment. Default.
    - `question` — something to follow up on.
  - `color` — color id from the lab's palette: `yellow`, `green`, `red`, `blue`, etc. Defaults to `yellow`. Overridden by the `type` color in the paper reader's overlay layer; still useful for the in-PDF underline color.
  - `comment` — free-text. Use the `|` literal-block form for multi-line comments.
  - `cite_in_drafts` — list of additional draft/grant ids: `[draft-id-1, grant-id-2]`. The file-level scope (`grant:` / `draft_id:`) is always merged in; this list is for the rare case a highlight serves multiple proposals.
  - `evidence_stance` — `for` or `against` if this highlight is evidence about a claim.

## Behavior rules for Claude when invoking this skill

1. **Quote verbatim, don't paraphrase.** RM's importer searches the paper text layer for each quote. If the quote isn't found, the highlight is flagged unmatched and the user has to drop it. Better: fewer well-anchored quotes than many fuzzy ones.
2. **Pick page numbers from the paper's printed pagination, not the PDF page index.** They usually agree, but on some journal layouts the first PDF page is a journal cover and printed page 1 is PDF page 2. Confirm with the user if unclear.
3. **Comments should explain *why this quote matters for the bucket*** — not summarize the paper. The whole reason a paper has multiple overlays is that the same quote may be relevant to GELS for one reason and irrelevant to MEBP. Comments should reflect the lens.
4. **Don't create the file silently.** Write to `<paper-slug>.paper-overlay.md` in the cwd, then tell the user the path and a one-line summary of what's in it. They confirm before you write more.
5. **One overlay file per (paper, bucket) pair.** If the user asks for a second pass over the same paper for the same bucket, append to or rewrite the existing file rather than creating a sibling.
6. **No PII in comments.** Overlays end up in Firestore at lab visibility; treat as semi-public.
7. **Don't make up DOIs or paper ids.** If you don't know one, ask. The importer will refuse to apply an overlay whose `paper_id` doesn't match the open paper.
