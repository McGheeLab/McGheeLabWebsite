---
name: grill-then-plan
description: Interview the user across the decision tree before writing a CodeLog/ClaudesPlan/V{n}_*.md plan, so ambiguity gets surfaced now instead of discovered mid-implementation. Pattern adapted from Matt Pocock's /grill-me. Use when the user says "let's plan X", "draft a plan for X", "next version should add X", or hands you a wishlist.md item to break ground on. Do NOT use for trivial single-file edits, typo fixes, or already-decided refactors — those skip straight to the plan or to implementation.
---

# /grill-then-plan — interview, then write the V-numbered plan

This skill front-loads the questions you'd otherwise discover mid-implementation. It does NOT touch code. It produces one file: `CodeLog/ClaudesPlan/V{next}_{slug}.md` in the format used by the existing 179 plans in that directory.

The pattern is Matt Pocock's `/grill-me` adapted to this repo's mandatory plan-before-code ritual.

## When to invoke

The user is about to start a new version's worth of work and has said something like:

- "Let's plan V3.X — I want to add a missing-PDF queue to the library"
- "Make me a plan for the grant portal scraper"
- "Walk me through what V3.182 should do"
- "Grill me on the slack-history migration before we write the plan"

If the user is mid-implementation and just wants help with a single concrete edit, **don't run this skill** — it's overhead for small changes. Reserve it for new versions or any change touching multiple files / both UI + data layer / both `rm/` and Firestore rules.

## Phase 1 — Orient

Before asking anything, do these reads silently:

1. Open `git log --oneline -20` to see what's just shipped and what `V{next}` should be.
2. Check `rm/wishlist.md` if the user named a wishlist item — pull its "affected files", "reuse strategy", "done when", and "open questions" so you don't ask things already answered there.
3. Glance at `CodeLog/ClaudesPlan/` for the 2 most recent plans to confirm the current format (length, headings, level of CSS-diff detail).

Then announce: "I'm going to grill you on this before writing the plan. Expect 5–30 questions. Say `plan it` when you're ready for me to write."

## Phase 2 — Grill

Walk the decision tree, branch by branch. **One question per turn.** Don't dump a list — questions branch based on earlier answers. Cover these axes in roughly this order, skipping any that the wishlist item already answers verbatim:

### A. Goal & scope
- What's the user-facing outcome? One sentence.
- Who's the user — Alex only, lab members, admin-only, external visitors?
- What does "done" look like? List the 2–4 observable behaviors.
- What's explicitly OUT of scope for this version (deferred to V{next+1} or beyond)?

### B. Reuse first
- Is there an existing module / function / pattern that already does most of this?
  Read the candidate before asking the user — if it's an obvious reuse, propose it instead of asking.
- Is this a generalization of something that already exists in `rm/js/` or `js/`?
  If so, do we refactor the existing thing or fork a new copy? (Default: refactor.)

### C. Files affected
- Which `rm/js/*.js` modules are touched?
- New page (`rm/pages/<slug>.html`) or extend an existing one?
- New CSS — into `rm/css/<topic>.css` (new) or fold into an existing file?
- Any `js/api-routes.js` changes? (New scope, new path, new shadowJson behavior?)
- `nav.js` link needed? `dashboard.js` summary card needed?

### D. Data layer
- New Firestore collection or path, or reusing existing? Spell out the full path.
- `scope: 'user'` (per-user) or `scope: 'lab'` (admin-write shared)?
- `shadowJson` on or off? (On = dual-writes JSON for local-dev seed; off = Firestore-only.)
- Composite indexes needed in `firestore.indexes.json`?
- Security rules: any new `match /...` blocks in `firestore.rules`? Reusing `isLabMember()` / `isAdmin()` / `isLabContributor()` or do we need a new gate helper?

### E. Cloud Functions
- Any `functions/*.js` touched? If yes, which: gmail-scraper, calendar-proxy, ics-scraper, stats-updater, oauth, chat, tasks?
- Deploy ritual reminder: `firebase deploy --only functions` from parent repo.

### F. Multi-tenant & gating
- Is this lab-member gated, admin-gated, or guest-visible?
- Cross-user view (admin views another member's data)? If yes, does it bypass the adapter via direct `firebridge.db()` refs (like PMR does)?
- Read-only vs read+write per role?

### G. Mobile / responsive
- Mobile-first or desktop-first? Both?
- Touch interactions (drag, swipe, long-press)? Tabular UI that needs a 2-row card on narrow screens?
- The "feedback_focused_tools_not_references" memory: is this a focused tool or a reference? If reference-shaped, push back — propose splitting into focused tools.

### H. Release ritual (always ask)
- Does `sw.js` CACHE_VERSION need a bump? (Almost always yes for any JS/CSS/HTML change.)
- Should `version_push.py` run with `--major` or default minor bump?
- Anything that requires a Firestore rules deploy or a Cloud Functions deploy *before* the FTP push? (Order matters — rules first or the new UI 403s.)

### I. Rollback story
- If this breaks in production, what's the rollback? Git revert + re-FTP? Disable a feature flag? Manual Firestore cleanup?
- Any irreversible data writes? (Schema changes, deletions, role flips.) If yes, dry-run plan?

### J. Open questions / unknowns
- What are you NOT sure about? List them as `Open questions` in the plan so they're visible during implementation rather than buried.

## Phase 3 — Restate

When the user says `plan it` (or equivalent), before writing the file:

1. Restate the plan in 5 bullets. Wait for confirmation.
2. If they correct anything, fold the correction in and restate once more.
3. Then — and only then — write the file.

## Phase 4 — Write the plan file

Output to `CodeLog/ClaudesPlan/V{next}_{kebab-slug}.md`. Match the format of the most recent plans in that directory. Required sections:

- **Goal** — one paragraph, user-facing outcome
- **Problem** — what's wrong / missing today
- **Approach** — how we solve it, with concrete file-by-file changes
- **Files modified / added** — bulleted list with paths and one-line per-file description
- **Data model changes** — Firestore paths, rules, indexes, scope decisions
- **Out of scope** — what we deliberately don't do this version
- **Release ritual** — sw.js bump? rules deploy? function deploy? FTP push order?
- **Rollback** — how to undo if it breaks
- **Open questions** — anything unresolved that you want to flag for during implementation
- **Verification** — a short manual-test checklist the user runs after the FTP push

Length target: match the existing plans (200–800 lines depending on scope). Don't pad.

## What you do NOT do in this skill

- **Don't write code.** This is a planning skill. Code comes in the next session, opened against the plan file.
- **Don't skip questions to save time.** The whole point is front-loading them. If the user says "just write the plan," push back once — explain that this is the cheap step — and only proceed if they insist.
- **Don't ask everything at once.** One question per turn. Branches matter.
- **Don't invent answers.** If you don't know whether something needs a new Firestore index, say "I don't know, can you check?" not "let's assume yes."
- **Don't bump the version yourself or run `version_push.py`.** The plan file is the artifact; the version bump happens at ship time.

## Hand-off

After the file is written, tell the user:

> Plan written at `CodeLog/ClaudesPlan/V{n}_{slug}.md`. Open it, skim, push back on anything wrong, then we move to implementation in a fresh session.

Then stop.
