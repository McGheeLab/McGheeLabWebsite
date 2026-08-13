# FuturePlan 12 — Bridge the paper builder ↔ library ↔ reader

> **Status:** all three releases implemented in one pass (working tree,
> uncommitted): R1 → V3.350 (Evidence Inbox + live `#ann-` deep links),
> R2 → V3.351 (richer citation rows + add-by-DOI + stale-index refresh),
> R3 → V3.352 (atomic `LIBRARY_LINKS` helper + library drafts badge).
> **Follow-on (2026-07-13):** V3.363 (FuturePlan 09, library groups shelf)
> builds on R3's `linked_drafts` linkage — draft-kind groups on the library
> page mirror a draft's linked papers automatically.

## The idea

FuturePlan 07 finished the builder itself. But the builder, the paper
**library**, and the paper **reader** still behaved as three silos with
one-directional seams. This plan turns reading → curating → drafting
into one loop.

## Ground truth that motivated it (verified 2026-07-13)

1. **`cite_in_drafts` was write-only.** The reader lets a student flag a
   highlight "cite in draft X" (`papers/{id}/annotations.cite_in_drafts`),
   but nothing in the builder ever read the flag. Reading work dead-ended.
2. **`#ann-{annId}` deep links were inert.** claims-panel.js and
   paper-bullet-claims.js emit them; library-paper.js never read
   `location.hash`, so evidence links opened the paper without landing
   on the highlight.
3. **The citation popover ignored library richness** — no abstract
   (lives in `items/{id}/details/main` via LIBRARY_EXTRAS), no tags, no
   PDF-availability signal; and the citation index was a one-shot
   session cache (papers added mid-session invisible until reload).
4. **`linked_drafts` had 4 duplicate whole-array read-modify-write
   implementations** (paper-equations `_toggleLinkToDraft`,
   paper-overlays `linkDraft`/`unlinkDraft`, grant-editor
   `tagPaperWithGrant`/`unlinkPaperFromGrant`) — each `api.load` →
   mutate → `api.save('items.json')`, a full-collection batch replace.
   Two concurrent writers = silent lost update.
5. **Library page showed no draft linkage** at all.
6. **Firestore rules verdict:** the annotations read rule only proves
   `visibility=='lab'` OR own-uid, so a bare
   `array-contains cite_in_drafts` query fails for non-admins. The
   Evidence Inbox mirrors ANNOTATION_SYNC's two-query split (lab +
   own-private) per paper — provable, no private leakage, **no rules
   change**. Composite index not expected (single-collection `==` +
   `array-contains`); contingency recorded in the R1 plan doc.

## Releases

| Release | Scope |
|---|---|
| **V3.350 — Evidence Inbox + live deep links** | New `rm/js/paper-evidence-inbox.js`: "Reading evidence for this draft" section at the top of the References pill tab — every highlight flagged `cite_in_drafts` for this draft plus claims-evidence highlights, grouped by paper, quote/comment/stance/type, one-click **Insert citation** + **Open highlight**; rows dim once the paper is cited. `#ann-{annId}` hash landing in library-paper.js (`ANNOTATION_OVERLAY.focus` after sync load, lazy-page safe). `PaperBulletClaims.getAllClaims()` export. |
| **V3.351 — Richer citation rows + live sync** | Citation-index projection gains `hasPdf` + `tags`; popover rows and References rows show 📄 + tag chips + lazy "Abstract ▸" (memoized `PaperEditor.fetchAbstract` via LIBRARY_EXTRAS); unknown-`[@key]` add-to-library modal gains a 🔍 DOI/title lookup (LIBRARY_METADATA) that builds a full item instead of a bare stub; `PaperEditor.ensureFreshCitationIndex(maxAge)` re-fetches a stale index on References-tab open / popover open (5-min window). |
| **V3.352 — Atomic links + library visibility** | New `rm/js/library-links.js`: `LIBRARY_LINKS.toggleDraftLink(itemId, draftId, makeLink)` — single-doc `update()` with `arrayUnion`/`arrayRemove` + `updatedAt` serverTimestamp (concurrency-safe; cache-probe friendly). All four duplicate writers refactored to it. Library page rows get a "→ N drafts" badge with draft titles (from `projects/papers.json`) in the tooltip. |

## Key designs

- **Evidence Inbox data flow:** fan-out set = papers linked to this
  draft ∪ papers already cited ∪ papers appearing in claims evidence.
  Per paper, two one-shot Firestore queries (lab-visible + own-private,
  both filtered `cite_in_drafts array-contains draftId`); claims
  evidence `{paperId, annId}` fetched by id with `.catch(()=>null)`
  (rules reject others' private — skip silently). Dedupe by
  `paperId|annId`. No live subscriptions: refresh on tab open, manual ↻,
  debounced `paper-citations-loaded`.
- **Deep-link landing:** capture `#ann-{id}` at boot keyed to the
  deep-linked paper id; on each ANNOTATION_SYNC onChange, if pending and
  the annotation is in the list → `ANNOTATION_OVERLAY.focus(annId)`
  (which `gotoPage`s first; the per-page render hook re-applies the
  focused ring on lazy pages) with a 250 ms second nudge, then clear.
- **Live counters explicitly deferred:** `annotation_count` /
  `evidence_count` / `cited_in_drafts` on library items remain dead
  fields; the designated future mechanism is a Cloud Function `onWrite`
  on `papers/{id}/annotations` maintaining the counters — out of scope
  here.
- **Grant titles in the library badge tooltip** fall back to the raw id
  (resolving grant titles needs full items.json — future work).

## Firebase deploys

None required. No firestore.rules change (see verdict above). If the
console ever throws `failed-precondition` on the inbox queries, add
composite indexes on `annotations` (`visibility ASC + cite_in_drafts
CONTAINS`; `creator.uid ASC + visibility ASC + cite_in_drafts CONTAINS`)
to `firestore.indexes.json` and `firebase deploy --only
firestore:indexes`.
