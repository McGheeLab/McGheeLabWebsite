# FuturePlan 10 — Lab Notebook Upgrade (Mobile-Native Capture + Experimental-Design Scaffolding)

**Intent:** make `rm/pages/lab-notebook.html` the place students *want* to
record bench work — phone-native capture with zero input friction, plus
lightweight scaffolding that guides them toward well-designed experiments.

**Status:** ✅ ALL FOUR PHASES IMPLEMENTED (2026-07-13) as
**V3.359** (mobile-native layout), **V3.360** (seamless input),
**V3.361** (design scaffolding), **V3.362** (connection & adoption) —
in working tree, uncommitted, FTP pending. `sw.js` CACHE_VERSION
330 → 334. Plans of record:
`CodeLog/ClaudesPlan/V3.359_notebook_mobile_native.md` ·
`V3.360_notebook_seamless_input.md` ·
`V3.361_notebook_design_scaffolding.md` ·
`V3.362_notebook_connection_adoption.md`.
Verified: `node --check` on all touched JS + schema-function harness
(legacy hydrate, run_results pad/truncate, linked-id extraction,
excerpt cap). **Pending: live browser pass** (phone drawer/action
bar/keyboard, observation form + mic, template round-trip, iteration
links, desktop regression incl. V3.330 protocol-run panel).

**Fixed decisions (2026-07-13):**
- **Mobile + input UX ships first**, experimental-design scaffolding
  second — remove daily-use friction so the habit forms before the
  design features land.
- Templates = **hardcoded seeds + personal templates**, sharable via
  `.notebook-template.json` export/import (protocol-importer UX). A
  lab-shared template gallery (needs rules deploy) is a follow-up, not
  this cycle.
- **No AI features** this cycle (summarize / free-text→observations /
  next-experiment suggestions deferred — would need a functions deploy).
- **No witnessing / PI sign-off** — `witnessed_by` stays a reserved
  schema field.
- **No Firestore rules/indexes/functions changes anywhere in this plan.**
  Every phase is client-only, FTP-deployable.

---

## Why now

The protocol builder just got its major upgrade cycle (V3.315–V3.330,
ending with the nodal `design` block + live notebook run). The notebook
has strong plumbing — 400ms debounced autosave, live sync with echo
guard, camera capture (`<input capture="environment">`), SHA-256-deduped
uploads, DOE matrices, the V3.330 protocol-run panel — but a thin, dated
UX on top:

- **Mobile is an afterthought** despite camera being the flagship bench
  feature: one lone `@media (max-width:720px)` query
  (`rm/css/lab-notebook.css:1899`), no touch handling, no FAB;
  breakpoint flagged for standardization "when the page is rewritten."
- **Input friction**: observations via chained `window.prompt()`
  (`rm/js/lab-notebook.js:1175` — the code itself promises a Phase-2
  sticky-FAB mini-form + voice memos); tags via `prompt()` (`:1411`)
  while `NOTEBOOK_DEFAULT_TAGS` sits unused; full-innerHTML re-renders
  that blur focus (`renderEditor:716`, rail rebuilt per keystroke
  `renderRail:671`).
- **No experimental-design help**: entries start blank (no templates /
  clone / spawn-next-iteration — future hook at `renderSummaryHtml:1063`);
  the plan→running→complete phase lifecycle gives no planning scaffold;
  DOE tables generate runs but never capture results; the cross-entry
  picker for `reference_links kind:'notebook'` never landed.

## Invariants

- Vanilla JS, no build step. Additive schema only — `notebookHydrate()`
  (`rm/js/notebook-schemas.js:133`) must keep loading legacy entries.
- Sanitizer invariants: never inline base64 into `body_html`; images
  only from `firebasestorage.googleapis.com` / `blob:`.
- Desktop (≥1024px) stays visually unchanged in Phase 1.
- Per-release ritual: `CodeLog/ClaudesPlan/V{n}_*.md`, CHANGELOG,
  ARCHITECTURE, `sw.js` CACHE_VERSION bump, FTP.

## Reused infrastructure (no reinvention)

| Need | Reuse |
|---|---|
| Phone rail drawer | `window.MOBILE_DRAWERS` (`rm/js/mobile-drawers.js:30`) — init/open/close, scroll lock, Esc |
| Voice dictation | SpeechRecognition pattern from `rm/js/activity-tracker.js:971,1574–1631` (feature-detect, mic wiring, cleanup) |
| Prompt/confirm replacement | `window.RM_DIALOG.prompt` (`rm/js/rm-dialog.js:81`), `window.TOAST` |
| Touch idiom | scheduler V3.342 pointer model (`matchMedia` narrow gate, `touch-action: pan-y`) — reference only |
| Image pipeline | existing `NOTEBOOK_FIGURES.uploadImage` + `uploadAndAttach` (`lab-notebook.js:1565`) — untouched |
| Modal guard / DOM builder | `util.js` `safeCloseOnBackdrop:291`, `el():329` |
| Import/export UX shape | protocol importer flow (`rm/js/protocol-import.js`) for template JSON share |

---

## Phase 1 — Mobile-native layout (ships first)

**Files:** `rm/css/lab-notebook.css` (major), `rm/js/lab-notebook.js`,
`rm/pages/lab-notebook.html`. Effort: M-L.

1. **Breakpoint standardization** — replace the 720px query with
   canonical **640px (phone) / 1024px (tablet)**; adopt shell tokens
   (`--page-pad-*`, `--safe-top/bottom`). Desktop ≥1024 unchanged.
2. **Rail → slide-in drawer at ≤640px** — wrap `ln-layout` as
   `.rm-mobile-drawer-host`, rail as left drawer; `MOBILE_DRAWERS.init()`
   in `boot()` (`:4251`); ☰ button in `renderToolbar()` (`:646`);
   selecting an entry closes the drawer.
3. **Sticky bottom action bar (phone only)** — fixed bar, 44px+ targets:
   **📷 Capture · 🎙 Voice · ➕ Observation · 🏷 Tag** (voice/observation
   trigger existing flows until Phase 2 lands their upgrades);
   `padding-bottom: env(safe-area-inset-bottom)`; editor pane gets
   matching bottom padding.
4. **Keyboard handling** — `visualViewport` resize listener keeps the
   action bar above the keyboard and scrolls the caret into view in the
   contenteditable body.
5. **One-tap today** — `＋ Today` toolbar button: opens today's entry or
   creates it (title = date) and focuses the body. Phone empty state
   shows a large "📷 Capture into today's entry" affordance
   (create-then-camera in one tap).

Risk: CSS regression on desktop — scope all new rules inside the
≤640/≤1024 queries; verify desktop side by side.

## Phase 2 — Seamless input (kills every prompt())

**Files:** `rm/js/lab-notebook.js` (main), `rm/css/lab-notebook.css`.
Effort: M-L (slash menu is the M chunk; the rest S each).

1. **Inline observation mini-form** — replace `onAddObservation`
   (`:1175`) prompt chain with an inline form (text + optional
   metric/value/unit) inside the observations section; opened from the
   section header and the phone action bar. Timestamped on save as today.
2. **Voice dictation** — 🎙 mic on the observation form and body toolbar
   (activity-tracker SpeechRecognition pattern); hides when unsupported.
   Dictates into the focused field — no AI parsing.
3. **Tag chip autocomplete** — replace the tag `prompt()` (`:1411`) with
   a chip input suggesting `NOTEBOOK_DEFAULT_TAGS` ∪ tags harvested from
   the user's `_index` rows; Enter/tap adds, ✕ removes.
4. **Surgical re-renders (focus preservation)** — per-section refresh
   helpers (observations, attachments, references, tags) that replace
   only their own container instead of `renderEditor()`; debounce rail
   refresh, re-render only when index rows change, preserve scroll.
   Highest-payoff fix for "editor feels janky."
5. **Slash-command insert menu** — `/` in the body opens a popover:
   Observation, 🧪 Inventory chip, 📋 Protocol chip, 📷 Photo, 🧮 DOE,
   H2, divider — each delegating to the existing toolbar insert handlers.
6. **Dialog hygiene** — remaining `prompt()/confirm()` swept to
   `RM_DIALOG` / styled confirms.

Deferred as too-low payoff: swipe-between-entries, offline queueing.

## Phase 3 — Experimental-design scaffolding

**Files:** `rm/js/notebook-schemas.js`, `rm/js/lab-notebook.js`,
`rm/css/lab-notebook.css`. Effort: M.

1. **Plan panel** — new additive `plan` field: `{hypothesis,
   independent_vars[], dependent_vars[], controls, success_criteria}`
   (empty/hydrate/indexRow `has_plan`). Collapsible "🧭 Plan" panel above
   the body — expanded and emphasized while `phase === 'plan'`, collapsed
   chip once running. **Gentle nudge, no gate**: moving plan→running with
   an empty hypothesis shows a one-line toast hint.
2. **Entry templates** — built-in seeds in code (cell-culture day,
   imaging session, synthesis/prep, analysis, meeting notes: title
   pattern, tag set, plan-panel prompts, optional body skeleton) +
   **personal templates** in a `_templates` doc in the existing
   `userData/{uid}/notebook` subcollection (owner-writable already —
   zero rules impact). Toolbar `New ▾` split button: *Blank · From
   template… · Clone last entry · Save current as template*. **Sharing**:
   export/import `.notebook-template.json` (mirrors protocol importer).
3. **Spawn next iteration** — on complete/closed entries, "↻ Next
   iteration" (the future hook at `renderSummaryHtml:1063`): new entry
   carrying forward project, tags, protocol_refs, plan (hypothesis
   editable), DOE factors (not results); back-reference
   `reference_links {kind:'notebook'}` both ways; title auto-increments
   ("… — run 3").
4. **DOE loop closure** — `design.runs` rows gain additive
   `{result, outcome_note}`; design table renders an editable Result
   column; ⬇ CSV export of factors+results. No stats engine.

Risk: template JSON import must validate/sanitize seeds through the
existing sanitizer before insertion.

## Phase 4 — Connection & adoption

**Files:** `rm/js/lab-notebook.js`, `rm/js/notebook-schemas.js`,
`rm/css/lab-notebook.css`. Effort: M.

1. **Cross-entry picker + backlinks** — the missing picker for
   `reference_links kind:'notebook'`: modal over index rows with search →
   inserts `lab-notebook.html?entry=<id>` links (add `?entry=` deep-link
   handling in `boot()`). Project `linked_entry_ids[]` into index rows so
   a "🔗 Linked from" section computes backlinks from `_index` alone.
   Together with Phase 3's spawn-iteration this enables experiment chains.
2. **Full-body search** — add a ~300-char `excerpt` of `body_text` to
   `notebookIndexRow` (`notebook-schemas.js:205`) and match it in
   `filteredIndexRows` (`lab-notebook.js:622`). True full-text over
   complete bodies deferred — `_index` must stay small.
3. **Rail filter chips** — compact phase + project chips above the rail
   (returning the facets removed in V3.117, in phone-friendly chip form).
4. **Weekly pulse** — one toolbar line: "3 entries this week · 5-day
   streak". Deliberately light; no further gamification.
5. *(Stretch)* real delete: `onDeleteEntry` (`:4225`) writes `{}` and
   orphans attachments — adopt a real delete only if the api adapter
   grows a delete verb; otherwise keep the stub and note it.

---

## Verification (each phase)

1. `node --check` on every touched JS file.
2. Local run: `RM_WRITE_ALLOWLIST=mcgheealex@gmail.com python3
   rm/server.py` → `http://localhost:8000/rm/pages/lab-notebook.html`.
3. **Phone pass** (DevTools iPhone emulation + real phone when possible):
   drawer open/close, action bar above keyboard, camera capture into
   today's entry, voice observation end-to-end, 44px targets, safe-area
   on notched viewport.
4. **Desktop regression pass**: editor toolbar, protocol-run panel
   mount/freeze (V3.330 path untouched), DOE modal, inventory chips +
   safety modal, autosave + live-sync echo guard (two tabs).
5. **Legacy-entry hydration**: open a pre-upgrade entry — new fields
   backfill, nothing lost on save.
6. Ritual check before FTP: version claimed against current CHANGELOG
   head, `sw.js` CACHE_VERSION bumped, CHANGELOG + ARCHITECTURE updated,
   plan doc in CodeLog/ClaudesPlan/.

## Out of scope (recorded for later)

AI assist (summarize entry, free-text→observations, next-experiment
suggestions — needs functions deploy); witnessing/PI sign-off
(`witnessed_by` stays reserved); lab-shared template gallery (needs
rules); block-editor rewrite of the body (contenteditable stays);
offline entry queueing; swipe navigation between entries.
