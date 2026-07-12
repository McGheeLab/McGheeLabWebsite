# FuturePlan 03 — Protocol Builder → Interactive-Widget Parity

> **Status:** ✅ COMPLETE (2026-07-11). All five releases shipped to the
> working tree (client-only; FTP + `version_push.py` pending Alex's
> review — nothing committed yet). Mapped to versions:
> - Release 1 → **V3.315** (document chrome: heading/callout/docHeader, inline vocab, read-only doc view + print)
> - Release 2 → **V3.316** (table / kv / timeline)
> - Release 3 → **V3.318** (calculator: rich inputs, hero cards, computed tables)
> - Release 4 → **V3.324** (builder + layoutMap design panel)
> - Release 5 → **V3.325** (importer + `/protocol-import` skill catch-up)
>
> Numbering is non-contiguous because a concurrent session shipped
> FuturePlan 04 (Task Marketplace) into the same repo the same day and
> took V3.313/314/317/319–323. See each release's
> `CodeLog/ClaudesPlan/V*.md` and CHANGELOG entry.
>
> **Original plan (for reference):**
> **Origin:** wishlist roadmap session, 2026-07-11.
> **To activate:** pick the next release below, get `V{next}` from `git log --oneline -5`, write `CodeLog/ClaudesPlan/V{next}_{slug}.md` from that release's spec, then implement per the release ritual. Releases are ordered — do them in sequence.

## Context
**User decision (2026-07-11):** do *not* switch to Claude-authored raw HTML documents — **upgrade the block builder itself** with a real widget set so a user can build protocols that look like this, adding more widget features as needed. Rendering is **admin-trusted, inline, no sandbox** (authoring is already gated to admins/contributors). Widgets are **declarative block configs** interpreted by RM's own renderer — not injected HTML/JS — so the only code-execution surface is mathjs `evaluate` on formula expressions, already shipped (V3.117) and acceptable under admin trust.

### Foundation that already exists — reuse, don't rebuild

- **Block model** `{id, kind, status, body, attrs}` inside `tree:{meta, sections:[{id,label,order,children}]}`, Yjs-backed (`rm/js/protocol-schemas.js`, `rm/js/protocol-yjs.js`). Adding a widget = adding a `kind`: extend `PROTOCOL_BLOCK_KINDS`, write a `newX` factory + `normalizeTree` defaults, add a renderer case to the `rm/js/protocol-blocks.js` dispatch (~lines 923-928 at planning time). Unknown kinds already coerce to `step`, so old clients don't crash on new blocks.
- **The formula engine is the calculator's backbone** (`rm/js/protocol-formulas.js`): it already builds a doc-wide symbol table of named inputs → computed mathjs outputs with cross-block references, live recompute via the `protocol-vars-changed` bus event, and `[!var:name]` prose tokens. The gold-standard calculator is this engine + richer input UI + card/table output — not a new engine.
- Existing blocks fold in: `note` + `safety` → the generalized callout; the `materials` table → a preset of the generic table (keep inventory row-linking via `rm/js/protocol-inventory.js`); `figure` unchanged; section `label` → styled stage heading.
- Authoring gate: `firebridge.isAdmin()` / `isLabContributor()` — keep it.

## Release 1 — Document chrome: stages, callouts, branded header, print view

- New `heading` block (stage code + title + optional top-rule, e.g. `03 · Calculator`); section labels render as stage headers.
- Generalized `callout` block with `attrs.type ∈ {critical, note, assume, timing}` (folds today's `note`/`safety`; `timing` renders the "15–30 min active" pill). Migrate existing note/safety blocks on hydrate — do not rewrite stored docs.
- `docHeader` block (or `tree.meta` fields): lab brand from `labConfig/branding` (ties into the FuturePlan 05 tenancy seam), title, subtitle, meta chips — some bound to live symbol-table values (e.g. "N conditions").
- Inline vocabulary in rich-text bodies: pill spans (`functional`/`inert` styled tags), inline-math/`code` spans, subscripts — extend the prose sanitizer/renderer.
- New `rm/css/protocol-doc.css` matching the gold standard's look; read-only **document view** route (`?protocol=X&view=doc`) + `@media print` so browser print-to-PDF is the export. Toolbar "🖨 Print / Export" button (rm/pages/protocols.html, ~lines 149-156).

## Release 2 — Rich tables, definition list, timeline

- Generic `table` block (arbitrary columns, alignment, mono cells); `materials` becomes a preset of it, keeping inventory row-linking.
- `kv` (definition/derivation list) block for the appendix.
- `timeline` block: `attrs.marks[]` of `{at, label, sub, included}` rendered as the horizontal track.

## Release 3 — Calculator upgrade (multi-input → cards + computed tables)

- Extend the formula/symbol-table engine so a `calculator` block declares **rich inputs** — `{name, label, widget:'slider'|'number', min, max, step, unit, rangeHint, default}` — rendered as the gold standard's slider/number rows, writing straight into the existing symbol table.
- **Card outputs** (hero cards) and a **computed table** whose columns are expressions evaluated per row over a **named dataset** — extend `buildSymbolTable` to evaluate an expression under a per-row scope (row fields merged onto the global scope). This is the one real engine addition; keep it declarative (expression strings only — mathjs already runs them).
- Live recompute rides the existing `protocol-vars-changed` bus.

## Release 4 — Interactive builder + bound visualization (the plate builder)

- `builder` block: author-defined parameters (sliders with optional monotonic cross-constraints like Lₛ<L_M<L_L), an editable tag list (the ratio editor), and a **combination assembler** — segmented pickers + "add" / "add all" + a dedupe rule expressed as config (e.g. "merge rows where field X ≥ threshold", covering the gold standard's f=1 inert-merge). Output is a **named dataset** consumed by Release-3 calculators.
- `layoutMap` block: renders a dataset as a grid (the 24-well plate map) — grid dims + per-cell color/label bound to dataset fields, spare wells auto-filled.
- **Honest scope:** this generalizes the *class* of design-panel builders (parameters + list + assembled table + grid viz), not arbitrary bespoke logic. Domain quirks are expressed as config where they fit and deferred otherwise, per the user's "add more features as needed." 

## Release 5 — Importer + skill catch-up

- Extend `rm/js/protocol-import.js` + the `protocol-import` skill's JSON format to cover all new kinds (heading, callout types, table, kv, timeline, calculator, builder, layoutMap) so Claude can still generate importable protocols.


---

## Data model summary

No Firestore rules/index changes expected — all new state lives inside the existing protocol `tree` (Yjs doc). New block kinds must be added to `PROTOCOL_BLOCK_KINDS` + `normalizeTree` so old docs stay valid and unknown kinds keep coercing safely.

## Release ritual (every release)

1. `CodeLog/ClaudesPlan/V{n}_{slug}.md` before implementation. 2. CHANGELOG + ARCHITECTURE updates + sw.js CACHE_VERSION bump. 3. FTP only (no functions/rules deploys expected). 4. `python3 scripts/version_push.py`.

## Rollback

Client-only throughout: git revert + re-FTP + CACHE_VERSION bump. Stored protocols are forward-safe (unknown kinds coerce to `step`); the Release-1 note/safety→callout migration happens on hydrate, never as a stored-data rewrite, so old data is untouched.

## Open questions

1. Release 1 callout migration: hydrate-time coercion is chosen — confirm no other consumer reads raw `kind:'note'|'safety'` from the tree (grep before shipping).
2. Whether `docHeader` should be a block or `tree.meta` fields — decide during Release 1 planning (meta is simpler; block is more visible in the editor).

