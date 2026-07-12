---
name: architecture-pass
description: Periodic architectural scan over one RM subsystem (Tasks, PMR, Paper-builder, Library, Training, etc.) using the "deletion test" — for each module, ask "if this disappeared, does complexity drop or spread?" Outputs a report of deletion candidates, modules to fold together, and interfaces that have drifted from their original responsibility. Pattern adapted from Matt Pocock's /improve-codebase-architecture. Run every ~10 version bumps or before a major refactor. Do NOT run as part of every-PR ritual or inside a bug fix.
---

# /architecture-pass — scheduled architectural deletion-test

This skill is a **scheduled ritual**, not a workflow step. It produces a report; it does NOT change code. The report goes into `CodeLog/Architecture/architecture-pass-V{current}.md` and informs the next 1–3 cleanup plans.

The pattern is Matt Pocock's `/improve-codebase-architecture`, scoped to one RM subsystem at a time so it stays cheap to read.

## When to run

- Every ~10 version bumps (so roughly monthly given current cadence of ~1 version / week).
- Before a major refactor or before starting a new subsystem that overlaps an old one.
- When the user says "I think Tasks has accumulated cruft" or "PMR feels heavy now" — that intuition usually predates the evidence.

**Don't run this:**

- Inside a bug fix. Bugs get diagnosed via `/diagnose`, not via architecture passes.
- As part of every-PR ritual. The cost-benefit only works at low frequency.
- Across the whole repo at once. Pick one subsystem.

## Inputs you need

1. **Subsystem to scan.** One of: Tasks (`rm/js/tasks-*.js`), PMR (`rm/js/pmr.js` + section-comments + task-pmr-sync + task-assign), Paper-builder (`rm/js/paper-*.js`), Library (`rm/js/library*.js` + paper-overlays), Training (`rm/js/training-*.js`), Activity (`rm/js/activity-*.js`), Chat (`rm/js/chat.js` + functions/chat.js), Calendar (`rm/js/calendar.js` + functions/calendar-proxy.js), Equipment / Procurement / People (admin tools). Ask the user if not specified.
2. **Scope.** Just JS, or also the matching `pages/*.html` + `css/*.css` + Firestore rules + Cloud Functions?  Default: JS + its specific CSS + the routes for it in `js/api-routes.js`. Stretch: rules + functions if the subsystem has a server side.
3. **Time horizon.** "Quick pass" (30 min of reading, 1 page report) or "deep pass" (read every file in the subsystem, 3–5 page report). Default: quick.

## The deletion test (the core mental move)

For each module in the subsystem, ask:

> If I deleted this module entirely, what happens to the complexity of the rest of the system?

Three outcomes:

- **Complexity drops** → the module was overhead. Costs more than it saved. Delete or fold into its caller. Flag as **deletion candidate**.
- **Complexity stays the same** → the module is a thin pass-through. Probably fold into its caller. Flag as **fold candidate**.
- **Complexity spreads everywhere** → the module is a genuine deep abstraction (Ousterhout's "deep module": simple interface, lots of implementation). Keep. Flag as **load-bearing**.

The trap is mistaking *familiar* for *deep*. A module that's been around for 6 versions and has 400 lines isn't automatically deep — it might just be a familiar thicket. Apply the test honestly.

## Phase 1 — Inventory

List the modules in the chosen subsystem. For each:

- File path
- Public surface (exported functions, `window.*` globals, custom events)
- Number of call sites (grep its exported names)
- Approximate LOC
- Stated responsibility (from a comment at the top, or inferred from name)

This is mechanical. Use `grep` + `wc -l` + `Read` on the top 20 lines of each file.

## Phase 2 — Apply the deletion test

For each module, write 1–3 sentences:

| Module | Verdict | Reasoning |
|---|---|---|
| `js/tasks-buckets.js` | **load-bearing** | 2400 LOC of bucket/subtask state machine. Deletion would force 6 call sites to reimplement the 3-tier roll-up. Deep. |
| `js/tasks-archive-buckets.js` | **fold candidate** | 80 LOC, only called by tasks-buckets.js. Pass-through to firestore + cosmetic filter. Fold inline. |
| `js/yr-shared.js` | **deletion candidate?** | 200 LOC, was for the V3.X year-review feature. Are any of its exports still called? Check before deleting. |

Don't propose verdicts you're not sure about. If a module's call sites are unclear, mark it `unknown` and tell the user.

## Phase 3 — Interface drift

Separate from deletion, check whether each load-bearing module's *current* responsibility matches its *original* responsibility. Signs of drift:

- A "tasks" module that now also writes to PMR.
- A "library" module that now does grant-draft work.
- A helper named `formatDate` that now also handles timezone offsets, week-numbering, and ISO parsing.
- Functions whose names are stale: `loadOldData()` when there's no "new data" yet.

For each drifted module, propose one of:

- **Rename** if the body is consistent but the name is stale.
- **Split** if the body has accumulated multiple unrelated responsibilities.
- **Boundary fix** if responsibility leaks across the adapter (`rm/js/*.js` directly calls `firebridge.db()` instead of going through `api.load`/`api.save`).

## Phase 4 — Write the report

Output to `CodeLog/Architecture/architecture-pass-V{current}.md`. (If the directory doesn't exist yet — it should, but check — create the file alongside `ARCHITECTURE.md`.) Required sections:

- **Subsystem & scope** — what was scanned, what was excluded
- **Inventory table** — file / public surface / LOC / call-site count
- **Deletion candidates** — modules where the deletion test says "complexity drops". Include the concrete delete-and-fold proposal.
- **Fold candidates** — pass-throughs to absorb into their caller.
- **Load-bearing** — modules that pass the test. No action.
- **Interface drift** — rename / split / boundary-fix candidates.
- **Recommended follow-up** — pick 1–3 cleanup plans worth queuing into `CodeLog/ClaudesPlan/`. Each gets a one-line "what to do" and a rough cost estimate (S / M / L).
- **Open questions** — call sites you couldn't confirm, ambiguous responsibilities, decisions that need user judgment.

Length target: 1 page for a quick pass, 3–5 pages for a deep pass. No padding.

## What you do NOT do

- **Don't delete or fold anything yourself.** This skill produces a report. Cleanup happens in follow-up plans run separately, each with its own version bump and changelog entry.
- **Don't propose a rewrite.** If a module is bad, propose deletion or splitting. Not "rewrite it cleaner." Rewrites in flight tend to never land.
- **Don't recommend abstracting "shared patterns" across unrelated subsystems.** Three similar lines is fine; premature abstraction is worse than duplication.
- **Don't flag CSS class naming, ID conventions, or other stylistic stuff.** This is an architecture pass, not a style audit.
- **Don't run this on `firestore.rules` or `functions/`** unless the user explicitly asks. Rules and Cloud Functions have their own different review cadence.
- **Don't compare to "best practices" from outside this repo.** The convention here is no framework, vanilla JS, no build step. A recommendation that violates that baseline is a non-starter.

## Hand-off

After the report is written, tell the user:

> Architecture pass for {subsystem} written to `CodeLog/Architecture/architecture-pass-V{n}.md`. Recommended follow-ups: {1–3 cleanup plans}. Want me to break ground on any of them via `/grill-then-plan`?

Then stop.
