# RM Wishlist

Open work items for the RM tree (`mcgheelab.com/rm/`). Each item is sized so Claude can pick it up and implement without asking clarifying questions: it names the affected files, the user-facing change, the schema or data-model shift if any, what to reuse, and what "done" looks like.

Items are grouped by surface. The **Done** section at the bottom is an archive — keep it as a record, but don't re-implement.

---

## Library

### Missing-PDF queue

**Affects:** [rm/pages/library.html](rm/pages/library.html), [rm/js/library.js](rm/js/library.js), [rm/js/library-upload.js](rm/js/library-upload.js)

Surface library papers where `pdf_path` is empty / not found. From that queue the user can:
- Retry the auto-download pipeline per row.
- Upload a PDF manually (file picker, lands at the same Storage path other PDFs use).
- Mark "unobtainable" so the row drops off the queue.

**Done when:** the library page has a "Missing PDFs (N)" filter; each row has Retry + Upload + Mark-unobtainable buttons; uploaded PDFs immediately render in the paper viewer.

**Reuses:** existing Storage paths from `library-upload.js`; the auto-download pipeline endpoint.

### SSO VPN for off-campus paper downloads

**Affects:** [rm/js/library-upload.js](rm/js/library-upload.js) or the auto-download Cloud Function in [functions/](functions/).

Off-campus, journal PDFs gated by University of Arizona IP fail. Add a flow that authenticates via U-of-A SSO and routes the journal request through that session so the journal sees a campus IP.

**Done when:** a "Try via U-of-A SSO" option appears on download-failure rows; one SSO handshake covers a whole session, not per paper.

**Open questions (resolve before designing):** does U-of-A SSO expose a programmatic session token, or does this need a browser-side proxy / Cloud Function with stored credentials? What does U-of-A's TOS say about scripted access?

---

## Chrome extension

### Import open PDF from the active browser tab

**Affects:** Chrome extension (sibling repo).

Journals with CAPTCHAs or human-checks block our direct-download path. Manual workflow: user navigates to the PDF tab in the browser; the extension grabs the PDF from the tab's resource list and ships it to the library.

**Done when:** clicking the extension on any tab whose response is `application/pdf` uploads to the same Storage path as the auto-download pipeline, with metadata extraction running the same way.

**Reuses:** the existing extension's upload code path; metadata extractor in [functions/](functions/).

---

## Chat

### Slack history migration

**Affects:** [rm/js/chat.js](rm/js/chat.js) (or the chat module file), [functions/chat.js](functions/chat.js), an admin-run import script under `scripts/`.

Bring the lab's Slack history into RM Chat so old conversations are searchable in one place.

**Status:** [`scripts/slack_export.py`](../scripts/slack_export.py) (~670 lines) is partway there — pulls users, channels, messages, threads, reactions, and files from the Slack API and writes into Lab Chat's Firestore schema, idempotent on `slackTs`. Not yet complete; specifics TBD by the user.

**Done when:** an admin-run script reads a Slack export ZIP and writes messages into RM's chat collection with original timestamps + author UIDs preserved. Channels map 1:1 to RM channels.

**Open questions (resolve before designing):** include DMs? One-shot import or continuous sync? How are Slack user IDs mapped to RM Firebase UIDs (manual table? email match?)

### Star key users in the chat sidebar

**Affects:** [rm/js/chat.js](rm/js/chat.js), chat page.

Add a star toggle next to each user in the chat user list; starred users float to the top of the sidebar. Per-user, stored at `userData/{uid}/chatPrefs.starredUids: string[]`.

**Done when:** clicking a star pins a user to the top; persists across reloads; works on mobile width.

---

## Mobile / tablet apps

### iOS + Android downloadable wrappers

Wrap a subset of RM pages (Lab Notebook, Chat, Activity Tracker, Tasks) as installable iOS + Android apps. **The notifications are the value** — task due today, chat mention, PMR meeting tomorrow.

**Approach:** likely Capacitor or Tauri Mobile wrapping the existing web pages, plus FCM for push. The user has agreed to pay for App Store + Play Store accounts.

**Done when:** lab members install the app from the App Store / Play Store, sign in with Google, and receive push notifications for: subtask due today, chat mention, PMR meeting tomorrow, pending tracker entry > 24h old.

**Open questions (resolve before designing):** which subset of pages ships first? Push notification triggers — Cloud Functions or per-action client publish? Capacitor vs Tauri Mobile vs native shell?

---

## Lab Notebook ↔ PMR

_All current items shipped — see Done archive below. Future items in this section go here._

---

## Activity + task tracking (V3.160 follow-ups)

V3.160 shipped the shared `ActivitySignals` helper at [rm/js/activity-signals.js](rm/js/activity-signals.js), with producer hooks on lab-notebook, tasks-buckets (subtask due_date), tasks-dashboard (assigned-task sync), meetings (action items), and protocols. PMR has new Activity + Stats blocks; tasks dashboard has the pinned "Assigned to me" section + Inbox badge. Each follow-up below layers onto that helper without schema changes.

### Paper editor: first-edit-of-day signal

**Affects:** [rm/js/paper-editor.js](rm/js/paper-editor.js), [rm/js/library-paper.js](rm/js/library-paper.js).

Add a Y.Doc body change observer that fires on the first non-trivial edit of the day:

```js
ActivitySignals.recordWork({
  source: 'rm-paper',
  sourceRef: { kind: 'paper', id: paperId, path: 'papers/' + paperId },
  date: ActivitySignals.todayStr(),
  text: 'Paper writing: ' + paperTitle,
  categoryPath: ['research', 'writing', 'papers'],
});
```

Throttle to once per (paperId, date) — the helper's deterministic doc id makes re-fires no-ops, but skipping the call avoids unnecessary Firestore reads.

**Done when:** opening a paper and typing a character creates a pending tracker entry on today's date; subsequent edits don't duplicate; the toast shows once per session.

### Calendar event hook

**Affects:** [rm/js/calendar.js](rm/js/calendar.js), [rm/js/activity-tracker.js](rm/js/activity-tracker.js).

When the user creates a calendar event, fire `ActivitySignals.recordSchedule({source:'rm-calendar', date:event.date})`. Existing "Log it" click handlers in `activity-tracker.js` (~lines 1200-1250) should migrate from `source:'calendar'` direct writes to the helper so calendar events surface in the pending banner / Coming up lane automatically.

**Done when:** creating a calendar event creates a pending tracker entry on the event date; clicking "Log it" in the tracker confirms it; deleting the event calls `removeSchedule`.

**Blocked on:** the per-user Google Calendar OAuth refactor.

### Important People / conferences

**Affects:** [rm/js/important-people.js](rm/js/important-people.js).

When a person's `event_date` is set (conference, seminar, visit), fire:

```js
ActivitySignals.recordSchedule({
  source: 'rm-conference',
  sourceRef: { kind: 'person-event', id: personId },
  date: event_date,
  text: 'Conference: ' + personName,
  categoryPath: ['research', 'conferences', 'conf_attendance'],
});
```

Clearing `event_date` → `removeSchedule({kind:'person-event', id:personId})`.

**Done when:** entering a conference attendance date surfaces a pending tracker entry on that day with the "conferences" category prefilled; changing the date moves it; clearing removes it.

### Grants: submit_deadline

**Affects:** [rm/js/grants.js](rm/js/grants.js).

When a grant's `submit_deadline` is set or changed, fire `recordSchedule({source:'rm-grant', categoryPath:['research','writing','grants']})`. Marking submitted or deleting → `removeSchedule`.

**Done when:** a grant with a submit_deadline shows up as a pending tracker entry on that date; changing the deadline moves the entry; marking submitted removes it.

### Server-side tracker materialization on task-assign

**Affects:** [functions/](functions/) — new Firestore trigger.

Today admin assigning a task can't write the student's tracker entry — `firestore.rules` deny cross-user `trackerEntries` writes — so the student's session materializes the pending entry lazily via `syncAssignedToTracker` on next tasks-dashboard load. A Cloud Function trigger on `userData/{uid}/tasks/{taskId}` create can materialize it server-side, so the student sees it in their tracker before they open the tasks page.

**Approach:** function uses admin SDK to bypass rules; reads the just-created task; writes the same `ActivitySignals.recordSchedule` payload directly to `trackerEntries/{assigneeUid}/entries/{deterministicId}`. The deterministic id keeps it idempotent with the client-side path so function-fires-then-client-syncs doesn't duplicate.

**Done when:** admin assigns a task to a student who has no active RM session; within 30 seconds the student's tracker shows a pending entry on the due_date.

**Deploy:** alongside existing functions via `firebase deploy --only functions`.

### Auto-dismiss stale pending entries

**Affects:** [functions/](functions/) (preferred — daily cron) or [rm/js/activity-signals.js](rm/js/activity-signals.js) (fallback — client-side scan on tracker mount).

Pending entries that are never confirmed accumulate. Auto-dismiss any with `status:'pending'` AND `date < today - 30 days`. Sets `status:'dismissed'` + `dismissed_at:serverTimestamp()` + `dismissed_reason:'auto-stale'` so the user can audit later.

**Done when:** a tracker with 50 unconfirmed pending entries older than a month shows 0 pending; dismissed entries don't reappear in the banner or PMR Activity.

**Open questions:** 30 days right or too aggressive? Make it a per-user setting in [rm/pages/settings.html](rm/pages/settings.html)?

### Dashboard "you have N pending activities" card

**Affects:** [rm/js/dashboard.js](rm/js/dashboard.js).

Add a card to the RM home dashboard that reads `ActivitySignals.listPending(uid)` and shows the count with a click-through to `/rm/pages/activity-overview.html?tab=tracker`. Useful for users who don't visit the tracker daily — currently the only confirmation surfaces are the per-page toast (transient) and the tracker banner (only visible if you visit the tracker).

**Done when:** a "📋 N pending activities" card appears on the RM home page when N > 0; clicking opens the tracker filtered to pending.

---

## Grants

V3.178 shipped biosketch + facilities-doc generators. V3.179 shipped the grant writer + budget editor. The two items below are the **discovery half** of the Grant Writing workflow — opportunity ingestion and idea-to-grant matching. They were deferred at the user's direction so the writing tools could ship first; build them as a pair when picking the workflow back up. Full design context lives in [`~/.claude/plans/just-like-we-have-jiggly-cupcake.md`](../../.claude/plans/just-like-we-have-jiggly-cupcake.md).

### Federal grants portal + scraper

**Affects:** new `rm/pages/grant-portal.html`, new `rm/js/grant-opportunities.js`, new Cloud Function `functions/grant-opportunities-scraper.js` + helpers under `functions/helpers/grant-sources/`, new Firestore collection `grantOpportunities/{id}` + composite indexes in [firestore.indexes.json](../firestore.indexes.json), [rm/js/nav.js](rm/js/nav.js) (enable the Grant Portal link; new entry under the Research dropdown), [rm/js/api-routes.js](rm/js/api-routes.js) (optionally register a route, though direct Firestore reads are also fine — mirror the `protocols` pattern), [firestore.rules](../firestore.rules) (rule block: lab-read, scraper-only writes).

Aggregated browse of upcoming federal funding opportunities, plus per-user saved searches and Pivot-RP RSS ingestion. **One Cloud Function on a 24h schedule** fans in from five sources and dedupes by `sha1(source + ':' + externalId)`:

- **grants.gov** — daily XML extract (`GrantsDBExtractYYYYMMDDv2.zip`, no auth). Use `adm-zip` to unzip; covers ~95% of federal NOFOs cross-posted across agencies. Primary source.
- **NIH Guide** — weekly notices RSS at `grants.nih.gov/grants/guide/rss.xml`. Filter by IC for NCI/NIBIB/etc.
- **NSF** — `nsf.gov/rss/rss_www_funding_pgm_annc_inf.xml` + `rss_www_funding_upcoming.xml`. No auth.
- **SAM.gov** — `api.sam.gov/opportunities/v2/search` filtered by org code (HR001 = DARPA, N00014 = ONR, W911NF = ARL/ARO). Requires a free SAM.gov API key, 1k requests/day. One key covers all DOD.
- **Pivot-RP saved-search RSS** — Pivot has no public API. Per-user the user pastes saved-search RSS URLs into `users/{uid}.pivotRssUrls[{label, url}]`; the scraper fans out, fetches each, tags the resulting opportunity `source: 'pivot-rss'` + `discoveredByUid`. Plus deep-link buttons throughout the UI to `pivot.proquest.com/funding/results?keyword=…` (UA SSO handles auth).

UI: left filter rail (agency multiselect, mechanism, deadline range 0–365 days, $ range, eligibility), center list/calendar tab, right detail drawer. Detail drawer has a "**Start a draft from this opportunity**" button that calls `firebridge.db().collection('grantDrafts').add(...)` with `opportunityId` linked + the matching template auto-suggested (R01 → `nih-r01`, etc.). Saved searches at `userSavedGrantSearches/{uid}/searches/{id}` for the weekly digest email (V3.182's optional weekly Cloud Function).

**Firestore schema:**
```
grantOpportunities/{id}            ← id = sha1(source + ':' + externalId)
  source, externalId, sourceUrl
  agency, subAgency, ic            (e.g. NIH/NCI)
  mechanism, activityCode          (R01, R21, CAREER, BAA, ...)
  title, synopsisHtml, synopsisShort (≤280 chars for AI prompts)
  postedAt, openAt, deadlineAt, expectedAwardAt
  amountCeiling, amountFloor, awardsExpected, durationMonths
  eligibility[], cfdaNumbers[], topicsCache[]
  fetchedAt, fetchHash, active, archivedAt
  discoveredByUid?                 (Pivot-RP rows only)

userSavedGrantSearches/{uid}/searches/{searchId}
  label, filters{}, agencies[], mechanisms[], deadlineWindowDays,
  notifyEmail, notifyInApp, lastSeenAt

users/{uid}.pivotRssUrls: [{label, url, addedAt}]
```

**Rule template** (lab read, scraper-only writes — V3.178 reserves the slot already):
```
match /grantOpportunities/{id} {
  allow read:  if isLabMember();
  allow write: if false;           // Admin SDK only
}
match /userSavedGrantSearches/{uid}/searches/{sid} {
  allow read, write: if request.auth.uid == uid;
}
```

**Composite indexes:** `(agency, deadlineAt)`, `(active, deadlineAt)`.

**Done when:**
- `firebase deploy --only functions:scrapeGrantOpportunities` lands a working 24h scheduled job; manual trigger via `firebase functions:shell` populates `grantOpportunities` from grants.gov + NIH + NSF + SAM.gov in one run.
- Adding a Pivot RSS URL to `users/{uid}.pivotRssUrls[]` and re-triggering produces `source: 'pivot-rss'` rows tagged with the user's uid.
- `/rm/pages/grant-portal.html` lists opportunities with agency/mechanism/deadline filters; saved searches persist across reloads.
- Detail drawer's "Start a draft" creates a `grantDrafts/{id}` linked to the opportunity and redirects into the V3.179 grant editor.
- The Grants Portal entry in [rm/js/nav.js](rm/js/nav.js) is no longer hidden, and the `grant-writing` workflow seed's `pageIds` is updated to include `grant-portal`.

**Reuses:** scraper pattern from [functions/ics-scraper.js](../functions/ics-scraper.js) + [functions/gmail-scraper.js](../functions/gmail-scraper.js) (`onSchedule('every 24 hours', ...)` + idempotent upsert keyed on a deterministic id). UI primitives from [rm/css/style.css](rm/css/style.css) (chips, filter rails) and [rm/css/grant-doc.css](rm/css/grant-doc.css). Saved-search digest can extend the existing Cloud Functions notification harness.

**Open questions:**
- SAM.gov API key needs to be provisioned (`firebase functions:config:set samgov.key=…`). User has agreed to provision it — confirm key is in place before deploying.
- grants.gov daily ZIP is ~30 MB. Stream-parse via `adm-zip` rather than buffering; don't archive the raw ZIP to Cloud Storage unless audit requires it.
- NIH RePORTER (`api.reporter.nih.gov`) covers *awarded* projects, not open opportunities — don't confuse the two. RePORTER could feed a future "what's similar to this NOFO that's been funded recently" ranking prior on the detail drawer, but it's not the primary opportunity source.

### AI "match my idea to grants" matcher

**Affects:** new `rm/js/grant-match-ai.js`, mounted as a modal/tab on `rm/pages/grant-portal.html` (so depends on the portal item above).

User opens a modal on the portal page, types 1–3 sentences describing their idea, optionally narrows by filters (federal-only, deadline within N months, min $ amount). The matcher:

1. Queries the top 50 active opportunities sorted by `deadlineAt asc` matching the filters.
2. Builds a prompt: system = "You are a grant strategist for a biomedical / engineering lab", user = the idea text + JSON list of `{id, title, mechanism, ceiling, deadline, synopsisShort}` (truncated to ≤280 chars each → ~15k input tokens total, well within budget).
3. Calls Anthropic `claude-sonnet-4-20250514` via the existing client-side fetch pattern at [rm/js/activity-tracker.js:382-429](rm/js/activity-tracker.js#L382-L429), using the per-user API key stored at `users/{uid}.anthropicKey`.
4. Parses the JSON response (`[{opportunityId, score:0-100, fitReason, gapsToAddress}]`) and renders the top 10 as cards linking back into the portal detail drawer.
5. Footer deep-link: "**Search Pivot-RP for this idea**" → `https://pivot.proquest.com/funding/results?keyword=<encoded>` for non-federal coverage.

**Done when:**
- A modal opens from a "Match my idea" button on the portal; user enters an idea + clicks Match; ranked top 10 opportunities render with reason text.
- The Anthropic call is made directly from the browser using the user's stored API key; the modal gracefully prompts "Add an Anthropic key in Settings" if `users/{uid}.anthropicKey` is empty.
- "Open in detail drawer" + "Start a draft from this opportunity" both work from the result cards.
- Pivot-RP deep-link opens the prefilled keyword search.

**Reuses:** The Anthropic browser-fetch pattern from [rm/js/activity-tracker.js:382-429](rm/js/activity-tracker.js#L382-L429) — same headers (`x-api-key`, `anthropic-version: 2023-06-01`, `anthropic-dangerous-direct-browser-access: true`), same model (`claude-sonnet-4-20250514`), same per-user key storage. Portal detail-drawer rendering from the item above.

**Open questions:**
- Should the matcher also consider in-flight `grantDrafts` to suggest opportunities the lab is *already* writing toward (and rank those *out* to avoid duplicate efforts)? Leans yes — cheap to add.
- Weekly saved-search digest emails: optional add-on, runs as a Cloud Function on a `every monday 09:00` schedule that aggregates new opportunities matching each user's saved searches. Probably ships in the same V3.182 version as the matcher to round out the discovery half of the workflow.

---

## Helpers

### PCard helper: focused single-purpose tool

**Affects:** [rm/pages/pcard-helper.html](rm/pages/pcard-helper.html), [rm/js/pcard-helper.js](rm/js/pcard-helper.js).

The page works but is cluttered — click-to-copy defaults chips, expense-type pills, conditional fields, the output box, and a long "Other PCard form field tips" `<details>` block all share the page. Users come here to *generate one business purpose statement*, not to browse PCard reference material. Strip the page down to that one task: pick the expense type, fill a few text fields, copy a nicely formatted statement.

**Done when:**
- Expense-type selector + the 3–5 fields for that type + the output box + the Copy button are the entire page above the fold.
- The click-to-copy defaults strip and the "Other PCard form field tips" `<details>` are removed, or hidden behind a single low-emphasis "More info" link that the user never has to click to finish the task.
- Output renders live on every keystroke (already does) and the Copy CTA is the dominant action.

**Reuses:** existing `EXPENSE_TYPES` template registry + per-type `render(values)` functions in [rm/js/pcard-helper.js](rm/js/pcard-helper.js) — the rendering logic is fine, the surface around it is what's bloated. Same design rule as the rest of the helpers: focused single-purpose tool, not a reference encyclopedia.

---

## Paper editor

_No open items — recent ships moved to the Done archive._

---

## Done (archive)

### library-paper
- ✅ Left-side context menu listing all citations on the page, with hover-highlight + expand-to-see-more + add-to-library action.
- ✅ Search feature with top-ranked hits including highlighted text.
- ✅ External Claude-CLI workflow producing `.paper-overlay.md` files (via the `paper-overlay` skill) that render highlights + comments on the paper.
- ✅ Per-review-task overlay scoping — multiple overlays per paper, toggleable, scoped to a specific review (e.g. GELS vs MEBP).

### paper builder
- ✅ Add figures with all LaTeX render options + figure caption.
- ✅ Flag a claim for lit review, then add evidence to claims during paper reviews.
- ✅ Rich text features in paragraph text boxes.
- ✅ Standalone equation section (numbered or inline) with reference popout context menu for quick reference.
- ✅ Visual highlight on commented text (V3.216). V3.204 text-range anchors (`anchorStart`/`anchorEnd`/`anchorText` on `papers/{paperId}/comments/{commentId}`) now render as amber-tinted `<span class="pe-comment-highlight">` on the exact prose each comment targets; resolved-only spans get a thin dotted `.pe-comment-highlight-resolved` underline. Hover shows count via `title`; click opens the side panel filtered to those exact comment IDs (`openCommentsForBlockWithAnchorIds` + `commentsState.anchorFilterIds` + clearable `.pe-comments-anchor-scope` chip). `_mergedAnchorRangesForBlock` merges overlapping anchors per block; `applyCommentHighlightsToBlock` walks the rendered DOM the same source-space chip-aware way as V3.191 and wraps intersecting text-node slices. Idempotent. `bindYTextToContentEditable` gains an `opts.onRendered(el)` hook that fires after every full render; paper-blocks.js uses it to overlay highlights on initial mount + blur + remote edits + KaTeX deferred render. Repainted live on `paper-comment-counts-changed` (the comments subscription's onSnapshot event) so adds / resolves / deletes propagate without a paragraph re-render. Skipped while the body is focused (chip-source mode is on). No new Firestore schema.
- ✅ Soft per-block section locking during multi-user co-authoring (V3.217). Promotes `papers/{paperId}/presence/{uid}.focusBlockId` into a soft lock: first user to focus a block holds it (deterministic smallest-UID tie-break under contention), every other client sees a "Locked by Alex" badge on the toolbar with the holder's presence-color dot and cannot place a cursor / type into the block — every `[contenteditable]` descendant of the locked block flips to `'false'`. Holder also sees a green "You" self-badge (click to manually release). Stale locks self-clear via three mechanisms: existing 30s `PRESENCE_STALE_MS` filter in `paper-yjs.js` (disconnect backstop), per-block 30s idle timer in `paper-blocks.js` (no input → release), and 250ms-debounced blur release (focus leaves the block, but the relatedTarget check skips intra-block toolbar clicks). All wired via wrap-level delegated `focusin` / `focusout` / `input` listeners so skeleton bullets share the same timers as the body. `_selfOwnsThisBlock()` guard against stale-closure stomps. Non-holder clicks fire a transient `.pe-lock-toast` near the click point. New ctx helpers: `getLockHolderForBlock(blockId)`, `releaseLock()`, `getSelfFocusBlockId()`. `paper-yjs.js` is unchanged.

### Protocol builder
- ✅ New protocol builder page (V3.113+).

### Lab notebook
- ✅ Lab notebook page for adding experiments (V3.110+).
- ✅ Images flagged for PMR review (V3.161). 📌 toggle on notebook attachment thumbnails dual-writes `pmr_review_figures[]` on the notebook + `figure_reviews[]` on the next PMR period; PMR renders a Figure Reviews block with image preview, fullscreen lightbox, editable caption, deep-link to the originating entry, per-figure comment thread, and "+ Create follow-up task" wired through `TASK_ASSIGN`.

### PMR
- ✅ PMR as the canonical 1:1 conversation surface (V3.159). New `rm/js/section-comments.js` extracts the threaded-comment primitive from the paper builder and parameterizes it over `(collectionPath, scope)`; PMR adopts it on every block (project_overview, open_tasks, reference_links, weekly_entries + per-week, discussion + per-card, plus the new blocks below). New first-class **Barriers** block with status lifecycle (open → discussing → resolved), contentEditable description, paste-image upload via `PAPER_FIGURES`, linked-task chips, "+ Assign task" button, per-barrier thread. New **Paper writing** block auto-loads drafts where the student is in `authorUids` and `is_library_entry !== true`, with status pill + "open in builder" link + "+ task" button + per-paper thread. `task-assign.js` accepts `opts.source='pmr'` + `pmrPeriodId` + `pmrSectionId` + `pmrTargetId` + `onCreated` so PMR-originated tasks carry the back-link. Real cross-user admin view replaces the old "unsupported" placeholder: `loadIndex` / `loadPmrDoc` / `attachLiveSync` branch on owner-vs-cross-user and use direct `firebridge.db()` refs. Admin can read + comment + assign tasks; `scheduleSave`/`saveDoc` short-circuit when `isReadOnlyView()` so admin doesn't edit the student's doc. New `userData/{userId}/pmr/{periodId}/comments/{commentId}` Firestore rule (owner OR admin OR comment-author).
- ✅ Goals section with four time horizons (V3.186). New `GOAL_HORIZONS` const + `renderGoalsBlock` adds four rich-text cards at the top of `renderBody` (This semester / This year / PhD journey / Beyond PhD), each with a contentEditable body, last-updated chip in the header, and per-horizon comment thread. `emptyDoc` / `hydrateDoc` carry the new `goals: { short_term, this_year, phd, beyond_phd }` object (each `{text_html, last_updated}`); read-only-view guard prevents admin from editing.
- ✅ PMR bucket lifecycle: mark complete + archive (V3.189). Bucket schema gains `archived: boolean` + `completed_at: ISO string`; PMR Open Tasks block refactored to project→bucket→subtasks with a "✓ Mark complete" button when 100% of subtasks are done; archived buckets move to a collapsed "Archived buckets" section with `↶ restore`. Tasks page workspace mirrors the same lifecycle. Owner-only today (admin cross-user mark-complete deferred — `userData/{uid}/buckets` is owner-only per rules).

### features
- ✅ Admin adds users to a project from RM; propagates to the main website's people page; gates access to project resources (V3.96 / V3.126).

