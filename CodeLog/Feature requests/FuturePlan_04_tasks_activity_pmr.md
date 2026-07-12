# FuturePlan 04 — Task Marketplace + Activity Overhaul + PMR Workflows

> **Status:** ✅ IMPLEMENTED in full, 2026-07-11 — A1=V3.313, A2=V3.314,
> A3=V3.317, B1=V3.319, B2=V3.320, B3=V3.321, C1=V3.322, C2=V3.323
> (V3.315/V3.316/V3.318 were taken by the concurrent FuturePlan 03
> session). Plans in `CodeLog/ClaudesPlan/V3.31x/V3.32x_*.md`. Awaiting
> deploy: `firebase deploy --only firestore:rules` + `--only functions`,
> then FTP. Two-account verification checklist at the bottom still to run.
> **Origin:** wishlist roadmap session, 2026-07-11.
> **To activate:** pick the next release below, get `V{next}` from `git log --oneline -5`, write `CodeLog/ClaudesPlan/V{next}_{slug}.md` from that release's spec, then implement per the release ritual. The three workstreams (marketplace → activity → PMR) are independent of each other; releases *within* each workstream are ordered.

## Context

Wishlist items: *"the tasks need an overhaul as well, sharing tasks, asking for tasks etc needs work"*; *"Activity tracker needs to be overhauled — too much tracking that the user needs to do. active use of RM should be auto tracked, but we need to do something about how this data is presented its too clunky now"*; *"PMR needs to be better easier workflows"*.

What exploration found (2026-07-11):

- **Tasks:** cross-user assignment already works with push (`rm/js/task-assign.js` writes into the assignee's `userData/{uid}/tasks`, `functions/tasks.js` notifies), but there is **no request/ask-for-work flow** in any direction; workspace buckets and assigned tasks are two disjoint systems; `rm/js/sharing.js` has separate Sent/Assigned tabs.
- **Activity:** auto-capture exists (page-time via `rm/js/page-time-tracker.js` + scheduled tasks/meetings via `rm/js/activity-signals.js`), but every entry still demands manual **hours + a ✓ confirm**; the pending-confirm banner nags; presentation is double-nested tabs in `rm/pages/activity-overview.html`; `rm/js/activity-tracker.js` is 2152 lines of hours-centric UI, ML train/predict, and bulk-parse machinery.
- **PMR:** new periods go through a raw `window.prompt` (`wireNewPeriodButton`, rm/js/pmr.js ~lines 3998-4020); `suggestedPeriods()` (~line 244) exists but is unused; pulling a task before adding a weekly entry hits a hard alert (~line 909); no period archiving, so the select grows forever. pmr.js is a 4106-line monolith — splitting it is explicitly deferred.

## Locked decisions

- **One task marketplace** carries every cross-user flow: member asks for work, help/handoff on a task, PI posts claimable tasks. No parallel flows.
- **Activity hours are dead** — no durations, no confirm loop. Counts/streaks/what-you-did only. Legacy entries with hours stay readable.
- Claim = instant assignment (no creator-approval step in v1; cheap to add later — flagged as an open question).

---

## Workstream A — Task marketplace (Releases A1–A3)

**Data model — new lab-scope collection `taskMarket/{postId}`:**

```
kind: 'offer' | 'request' | 'handoff'
  offer   = posted task anyone can claim (PI → board)
  request = "I need something to do" (member → PI/anyone)
  handoff = take-over/help ask on a specific task (owner → named teammate)
status: 'open' → 'claimed'/'accepted'/'declined' → 'completed' | 'withdrawn'
title, description, createdByUid, targetUid (null = anyone), claimedByUid,
task_payload (subtask-shaped), source_ref { bucket/subtask path | pmr backrefs },
created_at, resolved_at
```

**Rules:** lab-member read; create requires `createdByUid == request.auth.uid`; update only by creator (withdraw/complete) or claimant/target (claim/accept/decline) — enforce the status *transition*, not free writes. Composite index likely `(status, created_at)` in firestore.indexes.json.

### Release A1 — model + board
Rules block + new page `rm/pages/task-market.html` + `rm/js/task-market.js` (board columns: Open offers · Requests · Directed to me · My posts), nav entry in `rm/js/nav.js`, api-route registration. Direct handoff accept/decline works end-to-end. Deploy: rules/indexes → FTP.

### Release A2 — claim materialization + notifications
On claim/accept, write the task into the assignee's `userData/{uid}/tasks/{taskId}` by **reusing `rm/js/task-assign.js` internals** (~lines 82-135 at planning time), stamping `marketPostId`; PMR backrefs (`opts.source='pmr'`) preserved. **New `functions/task-market.js`** onCreate/onUpdate triggers → `sendToUsers` (`functions/helpers/notify.js`) for: post directed at you, your post claimed, request answered (appKey `tasks`; add test types to `functions/test-notifications.js`). Deploy: functions → FTP.

### Release A3 — existing flows redirect through the market
- task-assign.js "Send to teammate" becomes a directed `handoff` post — **auto-accepted when sent by admin**, preserving today's PI-assigns-directly UX.
- tasks-buckets.js subtask context menu gains "→ Offer to market" / "Ask for help".
- `rm/js/sharing.js` Sent/Assigned tabs fold into the market page as filters.
- "I need work" button for members → `request` post + PI push.
- Huddle help-requests stay separate (different domain).

## Workstream B — Activity overhaul (Releases B1–B3) — hours are dead

### Release B1 — kill the confirm loop
Stop writing `hours`/`status:'pending'`; new entries are lightweight events `{date, source, categoryPath, text, kind:'work'|'schedule'}` in the same `trackerEntries/{uid}/entries` collection (deterministic ids kept for idempotency). Delete: the pending banner (`renderPendingBanner`, rm/js/activity-signals.js ~lines 258-347), per-entry hours inputs, `aiBulkParse`, ML train/predict, hours-centric Settings. Legacy entries with hours stay readable (year-review keeps its read path). **Reintroduce cheap first-action-of-day `recordWork` producers** in notebook, protocols, paper-editor — these were removed in V3.226 because of confirm burden, and that burden is gone.

### Release B2 — one activity surface
Collapse the double-nested tabs: activity-overview.html's `?tab=` shell keeps overview/timeline/email/lab-stats, but the tracker tab becomes a single page — GitHub-style calendar heatmap (per-day event count), current/best streaks, per-category counts for the selected range, recent-activity feed. `rm/js/activity-tracker.js` is largely rewritten smaller. `rm/js/page-time-tracker.js` stays as the presence signal (10-min windows → day-level "active on RM" events).

### Release B3 — consumers
PMR Activity block renders the heatmap strip + counts; dashboard card shows streak + this-week count; `rm/js/activity-summary.js` lab-wide table switches from hours to counts. The `shareActivity` rules gate is unchanged (firestore.rules ~lines 640-648).

## Workstream C — PMR easier workflows (Releases C1–C2)

### Release C1 — guided periods
Replace the raw `window.prompt` in `wireNewPeriodButton` with an RM_DIALOG flow: suggestion chips from the existing-but-unused `suggestedPeriods()` + a custom-slug field + **copy-forward checkboxes** (goals, project overview, reference links carry over from the latest period). Auto-create the current week on period open / task pull — delete the "Add a weekly entry first" hard alert.

### Release C2 — period lifecycle
`archived` flag on `_index` periods; the period select shows active ones with archived behind a toggle; "Archive period" action next to Submit-for-1:1. Optional `meeting_date` field on the period doc (date picker) — feeds FuturePlan 05's meeting-reminder push. **The 4106-line pmr.js monolith split stays deferred** (run the `architecture-pass` skill before ever touching it).

---

## Release ritual (every release)

1. `CodeLog/ClaudesPlan/V{n}_{slug}.md` before implementation. 2. CHANGELOG + ARCHITECTURE updates + sw.js CACHE_VERSION bump. 3. Deploy order: **functions → rules/indexes → FTP**. 4. `python3 scripts/version_push.py`.

## Rollback

- Marketplace: rules block is additive — revert + redeploy; claim-materialized tasks in user subcollections are user-deletable, no cleanup script needed.
- Activity: old entries are never rewritten — only *new* writes change shape, so reverting the client restores hours-writing; year-review reads both shapes throughout.
- PMR: client-only; git revert + re-FTP.

## Open questions

1. Should a claimed `offer` require creator approval before materializing? (Plan assumes instant assignment.)
2. Exact activity category taxonomy to keep once hours die — prune during Release B2.
3. Marketplace composite index — confirm the exact query shapes during A1 and add to firestore.indexes.json then.

## Verification (end-to-end, after all releases)

- **Marketplace, two-account test:** member posts "I need work" → PI gets push → PI attaches a task → member claims → task appears in member's tasks with `marketPostId` backref; a PMR-sourced handoff preserves its backrefs; admin "Send to teammate" still lands instantly.
- **Activity:** a day of normal RM use (notebook edit, protocol view, task check-off) populates the heatmap with zero confirmation clicks; streaks and per-category counts render; lab-stats table shows counts, not hours.
- **PMR:** create a period via the new dialog with copy-forward; pull a task without pre-adding a weekly entry; archive an old period and confirm the select shrinks.
