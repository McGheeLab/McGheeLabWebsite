# FuturePlan 13 — Library associations lifecycle + Lab Themes

> **Status: ✅ IMPLEMENTED (2026-07-14) as V3.365–V3.368** (all four
> releases in one pass, per Alex's directive). Rules deploy required for
> R3 (`firebase deploy --only firestore:rules`) **before** FTP.

## Why

FuturePlan 12 (V3.350–352) made `meta.library.linked_drafts` the durable
association between journal papers in the library and papers the lab is
writing, with one atomic writer (`LIBRARY_LINKS.toggleDraftLink`). But the
association was still nearly invisible and had no lifecycle:

- The builder's **citation popover** listed the whole library (empty query
  → first 20 of everything) instead of the papers marked as relevant to
  the current draft.
- Associations had **no pill UI** anywhere — the reader hid them inside
  the overlays popover; the library showed a passive "→ N drafts" count
  that couldn't resolve grant titles and couldn't add/remove.
- A draft's `status` could never leave `'drafting'` (no UI edited it), so
  associations to finished papers would pile up forever.
- `meta.library.cited_in_drafts` existed in the item schema
  (library-metadata.js `buildPaperItem`) with **zero writers** — there
  was no "associated but not yet cited" signal.
- Literature reviews had no shared home: V3.363 groups are per-user or
  admin-only, with no notes and no ranking — students couldn't
  co-organize papers around lab concepts.

## Decisions of record (Alex, 2026-07-14)

1. **Theme creation: any lab member.** Creator-or-admin edits theme meta;
   admin can archive/delete any theme.
2. **Synthesis notes: per-note block docs** (live `onSnapshot`,
   block-level last-write-wins with an "edited by X" notice). Yjs
   (protocol-yjs clone) is the documented upgrade path if character-level
   co-editing is ever needed.
3. **Ranking: simple "👍 helped me" vote** — one vote per student per
   paper per theme; papers sort by count; "Start here" badge on the top
   3 with ≥2 votes.
4. **Active/inactive associations are DERIVED from draft status**, never
   stored: paper drafts are active while `status !== 'published'`; grant
   drafts while status ∈ GRANT_DRAFT_STATUSES. No migration, no
   publish-time sweep, fully reversible (un-publishing reactivates).

## Releases

### R1 — V3.365: Association pills + status selector + derived lifecycle

- NEW `rm/js/library-associations.js` (`window.LIBRARY_ASSOC`): cached
  draftId → {title, kind paper|grant, status, active} resolver
  (three-source lookup: `projects/papers.json`, items.json grants,
  `grantDrafts`); reusable `renderPills` widget (active pills with kind
  badge + remove ×, inactive pills collapsed behind "+N inactive",
  "+" add-picker listing ACTIVE drafts only); writes via
  `LIBRARY_LINKS.toggleDraftLink`.
- Reader sidebar gains a **"Used in paper drafts"** pills block
  (between Categories and the share widget), two-way synced with the
  overlays widget.
- Library rows: the "→ N drafts" badge becomes an interactive
  **"→ N active"** button opening a quick-add popover (ghost "+ draft"
  button on unassociated rows); `draft:` search token (matches ids and
  resolved titles, composes with smart groups); "Draft associations
  (most first)" sort mode.
- Builder editor header gains a **status selector**
  (drafting/submitted/revising/rejected/published — util.js paper set),
  writing `projects/papers.json` like the authors panel. Publishing a
  draft instantly derives its pills inactive everywhere.

### R2 — V3.366: Cited-indicator + citation-popover scoping

- `LIBRARY_LINKS.setCitedInDraft(itemId, draftId, bool)` — atomic
  arrayUnion/arrayRemove on `meta.library.cited_in_drafts`.
- NEW `rm/js/library-cited-sync.js` (`window.CITED_SYNC`): the builder
  diffs the draft's live cited set (`getCitedKeysInPaper` → itemIds)
  against `cited_in_drafts` and applies idempotent per-item ops —
  debounced 30 s after local Yjs edits, one backfill pass ~15 s after
  connect, best-effort flush on pagehide; 50-op cap; read-only viewers
  never write; steady-state = zero ops. **No migration**: old drafts
  backfill organically the next time they're opened for ≥45 s.
- Association pills (reader, library, builder linked rows) show an
  **uncited dot** when the paper is associated with a draft but not yet
  cited in it.
- The builder **citation popover defaults to associated papers only**
  (linked ∪ already-cited), with a "Linked to this draft (N) | All
  library" scope toggle and an empty-scope hint. The References tab
  search stays whole-library — it IS the tool for associating more
  papers (hints relabeled).

### R3 — V3.367: Lab Themes foundation (RULES DEPLOY)

- NEW Firestore collection `labThemes/{themeId}`
  `{name, description, created_by, created_at, updated_at, archived}`,
  member-created (rules block after `librarySharedGroups`; subrules for
  notes / votes / comments shipped in the same deploy). Direct
  `firebridge.db()` refs — deliberately NOT an api route (the adapter's
  lab-scope save is a whole-collection batch replace; co-edited data
  must use per-doc writes).
- Paper membership = `meta.library.themes: [themeId]` via new
  `LIBRARY_LINKS.toggleTheme` (third atomic clone; rides the V3.309
  items branch — no items rules change).
- Library hub gains a third **"Lab Themes" tab** (`?tab=themes`):
  theme cards → detail view (editable meta, paper list, "+ Add papers"
  picker). NEW `rm/js/library-themes.js` + `rm/css/library-themes.css`.
- Reader sidebar gains a **theme chips editor** (autocomplete over theme
  names) below the associations block; library search gains a
  `theme:` token.
- **No firestore.indexes.json changes** in any release: all theme reads
  are whole-collection/subcollection gets with client-side sort;
  SECTION_COMMENTS queries orderBy-only by design. Keep it that way —
  adding a where+orderBy later will demand a composite index.

### R4 — V3.368: Synthesis notes + "helped me" voting + discussion

- Notes at `labThemes/{id}/notes/{noteId}`
  `{order, body_html, created_by, created_at, last_editor, modified_at}`:
  live `onSnapshot`, per-note contentEditable with 800 ms debounced
  field-patch saves, focused-note repaint deferral + "edited by X"
  notice, allowlist HTML sanitizer, midpoint-float ordering.
- Votes at `labThemes/{id}/votes/{uid}` `{helped: [itemId], updated_at}`
  (own-doc arrayUnion/arrayRemove): "👍 Helped me (N)" toggle per paper,
  client-side aggregation, sort by count, **"Start here"** badge on the
  top 3 papers with ≥2 votes — the jumping-off point for new students.
- One `SECTION_COMMENTS.mount` per theme (`labThemes/{id}/comments`)
  for threaded discussion.

## Later releases / backlog

- **Reading-queue states** per association (to-read / reading / done,
  per-user in userSettings) — a personal reading queue per draft.
- **Lit-review matrix export** — papers × evidence highlights ×
  cited-flag per draft or theme (CSV/MD from annotation-sync data).
- **Theme digests** — weekly rollup of new papers/notes/votes per theme
  (stats-updater Cloud Function pattern).
- **Journal-club mode** — spotlight one theme paper + live
  SECTION_COMMENTS backchannel.
- **Association-aware Evidence Inbox** — builder inbox prioritizes
  highlights from associated-but-uncited papers.
- **Publish-time nudge** — flipping a draft to `published` offers
  "review N papers still marked uncited in this draft."

## Deploy order

1. `firebase deploy --only firestore:rules` (labThemes block — R3).
2. FTP the repo (Cyberduck) — R1–R4 client code.
   No functions, no indexes, no storage changes.
