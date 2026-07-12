---
name: diagnose
description: Force a structured debugging sequence (reproduce → minimize → hypothesize → instrument → fix → test) instead of confidently proposing multiple wrong fixes. Pattern adapted from Matt Pocock's /diagnose. Use when the user reports a bug, an unexpected behavior, or "it's not working" — especially when the bug spans Firestore rules, the api adapter, and the DOM (where root cause is rarely where the symptom shows up). Skip for obvious typos, missing imports, or one-line clear errors.
---

# /diagnose — structured debugging, not confident guessing

This skill exists because the default LLM failure mode on a bug report is to read a stack trace and produce three confident, slightly-different broken fixes in a row. Each fix introduces new bugs. The user loses an hour.

This skill forces a sequence. You do NOT skip steps. You do NOT propose a fix before step 3.

The pattern is Matt Pocock's `/diagnose` scoped to this repo's three-layer reality (Firestore rules / api adapter / DOM state).

## When to invoke

The user has said something like:

- "The library page is showing duplicate papers after I import"
- "Why isn't the new task assignment showing up in the assigned user's queue?"
- "PMR weekly entries aren't saving on mobile"
- "Cloud function is timing out"
- "Drag-and-drop on tasks works on desktop but breaks on iPad"

If the user has already diagnosed the root cause and just wants the fix written ("the bug is X, fix it") — **don't run this skill**. Just write the fix.

If the bug is a one-line obvious typo or a missing import that the stack trace points to directly — **don't run this skill**. Just fix it.

## The sequence (do not skip steps)

### Step 1 — Reproduce

Before reading any code beyond what the user pasted, answer:

- Can the user reproduce it on demand? What are the exact steps?
- Does it happen for Alex only, all lab members, or guests? On which browser? Mobile vs desktop?
- Does it happen on `localhost:8000/rm/` (dev) or `mcgheelab.com/rm/` (prod) or both?
- What's the *observable* symptom — the exact thing that's wrong in the DOM, the network tab, the Firestore console, or the user's screen?

If the user can't give you reliable repro steps, **stop and ask** for them. Don't guess.

### Step 2 — Minimize

Reduce the reproduction to the smallest input that triggers it. Examples:

- "Duplicate papers on import" → which specific paper triggers it? Single import or only when re-importing? With or without a PDF?
- "Drag-and-drop breaks on iPad" → which subtask level? Within a bucket or cross-bucket? With a long press first or immediate drag?
- "PMR weekly entries not saving on mobile" → all blocks or just one type? Network-disconnected? Or is `firebridge.isLabMember()` failing silently?

Ask the user to confirm the minimal repro. If they can't reduce further, document the smallest case they have.

### Step 3 — Hypothesize (THIS is the gate)

State **2–3 hypotheses** about where the bug lives *before reading more code*. Each hypothesis names a specific layer and a specific mechanism. Examples:

> Hypothesis A: The api-firestore-adapter's batch-write is silently failing because we hit the 400-op chunk limit and the second chunk's promise isn't awaited.
> Hypothesis B: `firestore.rules` denies the write because `request.resource.data.diff(resource.data).affectedKeys()` includes a field we forgot to allow.
> Hypothesis C: The DOM optimistic-update is showing what *should* be saved, masking that the Firestore write never landed.

**You may not propose a fix in this step.** If you catch yourself writing "the fix is X" while hypothesizing, delete it and finish the hypothesis list first. The fix comes in step 5.

If you genuinely can't generate 2 hypotheses, you don't understand the bug yet — go back to step 1 or 2.

### Step 4 — Instrument

Pick the cheapest test that discriminates between the hypotheses. Options, roughly cheapest first:

- **`console.log` at a specific point.** Tell the user where to add it and what to look for.
- **Network tab inspection.** "Open devtools, repro, look for a 403/400 on `/v1/projects/.../documents/...`."
- **Firestore console check.** "Look at `userData/{uid}/tasks/{taskId}` after repro — does the field exist?"
- **A breakpoint** in the relevant `rm/js/*.js` function.
- **Re-run with rules emulator** if it's a rules-deny question and you can mock the auth state.

Pick ONE. Wait for the result. **Don't add five logs at once** — that just creates noise.

If the user is busy and can't run the instrumentation, fall back to the hypothesis you'd bet on highest, but say so explicitly: "I'm proceeding on hypothesis B without confirmation — flag if this turns out wrong."

### Step 5 — Fix

Now propose the fix. The fix must:

- Address the *confirmed* hypothesis (or the explicitly-bet-on one if step 4 was skipped).
- Be the minimal change that resolves the root cause. No surrounding cleanup, no refactor, no error handling for scenarios that can't happen.
- NOT introduce a new failure mode. If your fix has a tradeoff, name it.
- Reference the file path and line, not vague "somewhere in tasks-buckets.js".

If the fix turns out to be in a different place than hypothesized, that's fine — but say so: "Hypothesis B was right but the actual bug is in the helper it calls, not the helper itself."

### Step 6 — Manual test

After the fix is written, give the user a **specific manual test** that confirms the fix:

- "Open `localhost:8000/rm/pages/tasks.html`. Create a bucket with 401 subtasks. Add one more. Refresh. Confirm the 402nd subtask is still there."
- "Repro the original bug exactly as you described, confirm it no longer reproduces, *and* try one variation (different paper / different user / mobile) to confirm we didn't fix only the one case."

Include the version-control reminder if the fix is non-trivial:

- Does `sw.js` CACHE_VERSION need a bump? (Almost always yes for any rm/* change.)
- Does the changelog get the fix under `Bug Fixes`?

## What you do NOT do

- **Don't propose a fix in step 3.** Hypothesize first. If the user reads a fix proposal at the hypothesis step, they'll latch on and the diagnostic value of the other hypotheses is lost.
- **Don't add a try/catch as the "fix"** unless the root cause is genuinely an unhandled error path. Wrapping the failure in a catch silences the symptom and leaves the cause.
- **Don't write five console.logs.** One discriminating log beats five noisy ones.
- **Don't recommend a refactor.** "While we're in here…" is how bug-fix PRs grow into surprise refactors that break unrelated things. If you see something refactor-worthy, note it as an open question for `/architecture-pass`, not part of this fix.
- **Don't blame the user.** "You should have…" is never useful. If the bug needed a non-obvious step to repro, document the step in the plan or a wishlist note.

## Hand-off

After step 6, summarize in 2–3 lines:

> Root cause: [one sentence]. Fix: [file:line]. Manual test: [one line]. Changelog entry under Bug Fixes recommended.

Then stop. The user takes it from there.
