# FuturePlan 11 — CV builder upgrade: easier for students and everyone

> **Status:** ✅ ALL SIX RELEASES SHIPPED (2026-07-13, working tree —
> uncommitted pending review). R1→**V3.353**, R2→**V3.354**, R3→**V3.355**,
> R4→**V3.356**, R5→**V3.357**, R6→**V3.358**. `sw.js` CACHE_VERSION
> 324 → 330. No rules/indexes/functions deploys — the whole suite is
> FTP-only. Plans: `CodeLog/ClaudesPlan/V3.353_cv_editor_foundations.md`
> through `V3.358_cv_overview_polish.md`. (Original provisional numbers
> were V3.350+; the counter advanced to V3.352 before build, as this
> blockquote predicted.)

## The idea

The lab has **two CV apps sharing one Firestore document** (`cvData/{uid}`):

- **Public site** [`cv-builder.js`](../../cv-builder.js) (`#/cv`, ~1779 lines) —
  feature-rich, mobile-capable, but not where lab workflows point.
- **RM dashboard** [`rm/js/cv-editor.js`](../../rm/js/cv-editor.js) (~681
  lines) — the surface the dashboard card, year-review "add to CV",
  biosketch, and trainings all link to. It is the CV that students
  actually meet.

The RM editor is where the "easier to use" win lives, but today it has
real gaps: it is **hard-blocked on phones**
([`desktop-only-guard.js`](../../rm/js/desktop-only-guard.js)); it has **no
data-safety net** (delete is `confirm()` → gone; no undo; edits in one tab
silently clobber another); and **RM edits never propagate to the public
team profile** (only the parent builder calls `syncCVToProfile`, so a
student who curates their CV in RM sees nothing update on the public
site). There is no live preview, no manual reordering, no onboarding, and
publications must be typed in by hand even though the lab library already
stores them with full metadata.

**Goal:** a CV editor a first-year student can open on a laptop *or* phone,
import their publications in a click, edit without fear of losing work,
preview the formatted result live, and have it feed both their biosketch
and their public profile automatically.

Decisions of record:

- Target the **RM editor as the flagship**; upgrade
  [`rm/pages/cv-editor.html`](../../rm/pages/cv-editor.html) +
  [`rm/js/cv-editor.js`](../../rm/js/cv-editor.js) in place.
- The public `#/cv` app stays as-is; the shared `cvData` contract must keep
  working for it **and** for biosketch (section keys + entry `_id`s are the
  contract).
- Ship all four bundles: **data safety, live preview + curation,
  auto-pull publications, onboarding/guidance**.
- Make the RM CV editor **responsive** (remove it from the desktop-only
  guard).
- Delivery = phased releases from this doc, one version each.

## Ground truth that scoped the plan (verified 2026-07-13)

1. **Next free version is V3.350.** CHANGELOG head is V3.349; latest plan
   doc is `V3.349_scheduler_grid_skeleton.md`. Numbers are provisional —
   parallel sessions advance the counter.
2. **One service worker.** [`sw.js`](../../sw.js) `CACHE_VERSION = 321`;
   `/rm/*` is **network-first** (`sw.js:110-111`). There is **no
   `rm/sw.js`**. One bump per release (321 → 322).
3. **ORCID / BibTeX dialogs live in `cv-editor.js`, not `cv-importers.js`.**
   `openORCIDDialog` (L424), `openBibTeXDialog` (L524), `attachDOIFetch`
   (L623) are editor-private.
   [`cv-importers.js`](../../rm/js/cv-importers.js) exports only `fetchDOI,
   fetchCitationCount, fetchORCID, orcidSectionFor, parseBibtex,
   findDuplicates`.
4. **No author↔uid link in the library** — `meta.library.authors[]` is
   `[{given, family}]` with no uid. "Pull my pubs from library" (R4) must
   **name-match**, always behind a review checklist.
5. **`LIVE_SYNC.attach` cannot be used for `cvData`** (no api-route; it
   wraps `api.save`/`api.subscribe`). `firebridge.onSnapshot`
   (`firebase-bridge.js:429`) is query-shaped. Live sync must use the
   single-doc pattern
   `firebridge.db().collection('cvData').doc(uid).onSnapshot(...)` (mirrors
   the profile subscription at `firebase-bridge.js:138`). `firebridge`
   exports `db` (L1106), `updateDoc` (L1112), `onSnapshot` (L1118),
   `isAdmin` (L239/L1100).
6. **`toast.js` retry button label is hardcoded `'Retry'`**
   ([`toast.js:60`](../../rm/js/toast.js)) — usable as an "Undo" affordance
   only with a 1-line additive `opts.actionLabel`.
7. **Profile-sync needs NO rules deploy.**
   [`firestore.rules:170-172`](../../firestore.rules) lets an owner update
   their own `users/{uid}` doc when `role` is unchanged, so writing
   `{papers, posters, presentations, patents}` ships by FTP alone.
8. **Additive top-level fields survive the parent round-trip.** The parent
   loads `{...mkDefault(), ...data}` and persists the whole object with
   `merge:true`, so new keys (`trash`, `cv_meta`) are preserved. Biosketch
   reads only named sections + entry `_id`s (`productsOverride` resolves by
   `_id`) — **section keys and `_id`s are a hard contract.**
9. **Every consumer re-sorts by year with stable sorts**
   (`cv-editor.js:175`, parent, biosketch `deriveTopPubs`, `cv-export`
   group-by-year). So **canonical array order** is the correct reorder
   model (R3) — within-year manual order propagates everywhere with zero
   consumer changes and zero schema additions.
10. **Lab Overview is linked for everyone but readable only by admins.**
    [`nav.js:97`](../../rm/js/nav.js) (`CV Overview`) carries no gate;
    [`cv-overview.js:53-55`](../../rm/js/cv-overview.js) reads each user's
    `cvData` and swallows the permission error in a silent `.catch()`.
    `firestore.rules` restricts cross-user `cvData` read to owner||admin →
    non-admins see an all-zeros table. `nav.js` already supports
    `gate:'admin'` (→ `!!isAdmin`, L1330-1332).

## Release roadmap

Each release = one version bump + `CodeLog/ClaudesPlan/V{n}_*.md` plan +
CHANGELOG entry + ARCHITECTURE update + `sw.js` bump.

| Release | Scope | Bundle | Touches |
|---|---|---|---|
| **R1 — Foundations (✅ V3.353)** | Responsive shell (remove desktop-only guard); cross-tab live sync + echo guard; soft-delete with Undo toast + "Recently deleted" dialog; unified save-with-status + toast error/retry; **profile-sync gap fix** (RM saves → public profile); **Lab-tab admin gate**; JSON backup button; stale header-comment fix | Data safety | `rm/js/cv-editor.js`, `rm/pages/cv-editor.html`, NEW `rm/js/cv-profile-sync.js`, `rm/js/toast.js`, `rm/js/nav.js`, `rm/js/cv-overview.js` |
| **R2 — Live preview + templates + Word (✅ V3.354)** | Right-side live preview (iframe `srcdoc` from `CVExport.toHTML`, debounced; mobile toggle); 3 export templates (serif / compact / modern) in one generator; Word `.doc` export; `cv_meta.template` (additive) | Preview / curation | `rm/js/cv-export.js`, `rm/js/cv-editor.js`, `rm/pages/cv-editor.html` |
| **R3 — Curation: reorder + variants (✅ V3.355)** | Year-grouped list; drag + ▲/▼ reorder persisting canonical array order; audience variants reusing the parent's `cv_versions[]` model (hide sections/entries per export); variant-aware preview + exports | Preview / curation | `rm/js/cv-editor.js`, `rm/js/cv-export.js`, `rm/pages/cv-editor.html` |
| **R4 — Publications engine (✅ V3.356)** | "Pull from lab library" (name-match, review checklist, dedupe); ORCID enrichment via CrossRef-by-DOI (fills authors/volume/pages); batched + resumable citation refresh with progress | Auto-pull | `rm/js/cv-importers.js`, NEW `rm/js/cv-library-pull.js`, `rm/js/cv-editor.js` |
| **R5 — Onboarding & guidance (✅ V3.357)** | First-run "Get started" checklist rail deep-linking existing import dialogs; completeness "CV health" chip derived from doc contents; example-driven empty states; student hints in schemas | Onboarding | NEW `rm/js/cv-onboarding.js`, `rm/js/cv-editor.js`, `rm/js/cv-schemas.js` |
| **R6 — Lab overview + polish (✅ V3.358)** | Admin overview drill-in (read-only member CV render, staleness nudge); mobile polish; keyboard shortcuts (`n` new, `/` jump) | Polish | `rm/js/cv-overview.js`, `rm/js/cv-editor.js` |

Sequencing: R1 lands the responsive shell + unified save path + live-sync
**first** because every later feature renders through that shell and writes
through that path. Onboarding (R5) is late-but-one so its wizard steps
compose the R4 import flows.

## Key designs

### Reorder model → canonical array order (R3)

Drag rewrites the section array to display order (year-desc groups, manual
order inside). Verified stable-sort consumers propagate within-year order
with zero changes. A `_order` sort-key field is rejected — every consumer
would ignore it (an RM-only illusion + drift across three codebases).

### Delete-undo → `trash` array + toast Undo (R1)

Additive top-level field:

```jsonc
trash: [ { "section": "journals", "entry": { /* full entry incl _id */ }, "deleted_at": "<ISO>" } ]
```

Pruned to newest 50 and ≤30 days on every trash write. Survives reloads
and parent round-trips (§8), ~1 KB, powers both the 8 s Undo toast and the
"Recently deleted" dialog. In-memory-only undo dies with the tab;
whole-doc snapshot restore collides with the parent's whole-doc writes.

### Live sync + echo guard (R1)

Replace the one-shot `getDoc` load with a single-doc `onSnapshot`
listener. Copy the [`lab-notebook.js`](../../rm/js/lab-notebook.js) echo
guard: set `state.savePending = true` + `state.suppressUntil = now + 2500`
before each write; the snapshot handler bails on
`snap.metadata.hasPendingWrites || Date.now() < suppressUntil ||
savePending` (own echoes). If the entry modal is open when a remote change
lands, queue a re-render instead of applying it — the eventual save upserts
by `_id` into the fresh array, so a concurrent edit to a *different* entry
in the same section is preserved.

### Live preview → iframe `srcdoc` from `CVExport.toHTML` (R2)

Pixel parity with print/PDF (same generator), isolates the CV's print CSS
from `rm/css/style.css` both ways, makes template switching a pure
generator swap. Inline pane rejected (style bleed; `@media print` becomes
meaningless). Mobile gets a Preview toggle instead of a split.

### Profile-sync fix → client-side `rm/js/cv-profile-sync.js` (R1)

`window.CV_PROFILE_SYNC = { schedule(uid, doc), syncNow(uid, doc) }`;
`schedule` = 800 ms debounce. `syncNow` mirrors **exactly** the mapping in
[`user-system.js:656-691`](../../user-system.js) (journals→`papers`,
conferences→`posters`, presentations→`presentations`, patents→`patents`)
and writes via `firebridge.updateDoc('users', uid, {...})` — allowed with
no deploy (§7, role untouched). Fire-and-forget: on error `console.warn` +
one `TOAST.warn` per session; **never blocks or fails a CV save.** A header
comment cross-references `user-system.js` lines so the two mappings can't
drift. A Firestore-trigger Cloud Function is rejected (deploy friction,
duplicated mapping, cold starts, no added correctness).

### Lab-overview mismatch → hide the tab for non-admins (R1)

`cvData` carries semi-private material (grant amounts, student records,
address) — widening reads is a privacy change nobody asked for. Fix with
one `gate:'admin'` attribute on the nav item + an onAuth-gated tab render +
an in-page notice. Keep the rules owner||admin.

### Onboarding → persistent "Get started" checklist rail (R5)

Not a modal carousel. Steps (1. Profile basics → 2. Import publications:
ORCID / BibTeX / Pull from library → 3. Round out awards/presentations/
service → 4. Preview & export) each deep-link the *existing* dialogs.
Completion is **derived from doc contents**; only a
`cv_meta.onboarding_dismissed` flag is stored (additive).

## Release 1 (V3.350) — Foundations

Upgrade `cv-editor.js` **in place**. No Firestore rules/indexes/functions
deploy — all shared-doc changes are additive; the profile-sync write is
already permitted.

### R1 changes

- **NEW `rm/js/cv-profile-sync.js`** (~90 lines) — see "Profile-sync fix"
  above. Added to `mineScripts` in `cv-editor.html:159-163`.
- **`cv-editor.js`:**
  - Header comment fix (L1-11): replace the false
    `window.CVEditor.appendEntry` claim with the real API
    (`CVStore.appendEntry` in `cv-schemas.js`, used by `cv-send.js`).
  - Unified `savePayload(payload, opts)` replacing the five direct
    `firebridge.setDoc('cvData', …)` sites (L75, L397, L510, L577, L610):
    echo-guard flags before write; `setStatus('Saving…'→'Saved.')`;
    `TOAST.error(..., {retry})` + rethrow on failure; after success, if
    payload intersects `{journals, conferences, presentations, patents}` →
    `CV_PROFILE_SYNC.schedule(uid, doc)`. `saveSection(key, extra)` becomes
    a thin wrapper.
  - Live sync: replace `loadDoc` (L48) with `subscribeDoc()` (single-doc
    `onSnapshot` + echo guard + modal-open re-render queue).
  - Delete + Undo (renderEntry L200-206): drop `confirm()`; move entry to
    `trash`; `TOAST.success('Entry deleted', {actionLabel:'Undo',
    retry:undoFn, ttl:8000})`; `pruneTrash()`.
  - "Recently deleted" dialog (via existing `openDialog()` L411) with
    per-row Restore.
  - Toolbar: "⇩ Backup (JSON)" button.
  - Replace bare `alert()` "Not signed in" / no-DOI cases with `TOAST.warn`.
- **`rm/pages/cv-editor.html`:** remove `rm-desktop-only` (L76) +
  `desktop-only-guard.js` `<script>` (L141); add responsive CSS
  (≤900px sticky horizontal section rail, ≤640px full-screen modal +
  single-column form, `--tap-min` targets); move the tab-bar builder
  (L79-96) inside `firebridge.onAuth` and gate "Lab Overview" to
  `firebridge.isAdmin()`.
- **`rm/js/toast.js`:** additive `opts.actionLabel` (button text
  `opts.actionLabel || 'Retry'`, L60).
- **`rm/js/nav.js`:** add `gate:'admin'` to the `CV Overview` item (L97).
- **`rm/js/cv-overview.js`:** friendly admin-only empty state in
  `loadAndRender()` when `!firebridge.isAdmin()`.

### R1 release ritual

`CodeLog/ClaudesPlan/V3.350_cv_editor_foundations.md`; CHANGELOG entry;
ARCHITECTURE CV-module update (new `cv-profile-sync.js`, live-sync + trash
model); `sw.js` CACHE_VERSION 321 → 322 (re-check counter first). No
rules/indexes/functions deploy. FTP the tree.

### R1 verification

Local:
`RM_WRITE_ALLOWLIST=mcgheealex@gmail.com python3 rm/server.py` →
`http://localhost:8000/rm/pages/cv-editor.html`, sign in.

1. **Regression** — add/edit journals + awards; ORCID sync, BibTeX import,
   Refresh citations, MD/HTML/Print exports behave as before; Backup (JSON)
   downloads the doc.
2. **Undo** — delete → toast Undo restores in place; reload → restore
   persisted; expired toast → "Recently deleted" restores; >50 fake trash
   rows → pruned on next delete.
3. **Live sync (two tabs)** — edit in A → B updates ≤1 s, no self-echo;
   modal open in B, edit same section in A → B's draft untouched + chip,
   close → refresh; save from B → A's edit to a *different* entry survives.
4. **Mobile (390px)** — no interstitial; section rail scrolls; full-screen
   add/edit/save; delete + Undo tappable; exports reachable.
5. **Profile sync** — save a journal → `users/{uid}.papers` contains it,
   `role` untouched; conf/presentation/patent saves populate the
   corresponding arrays; a bulk ORCID import triggers one debounced sync.
6. **Cross-editor** — parent `#/cv` shows RM-created entries; a parent-side
   save leaves `trash` intact in Firestore.
7. **Biosketch** — `/rm/pages/grant-biosketch.html` lists new pubs; an
   existing variant's `productsOverride` still resolves.
8. **Lab Overview** — non-admin → nav link hidden + direct `?tab=lab` URL
   shows the notice; admin → table unchanged.
