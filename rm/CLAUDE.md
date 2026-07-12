# ResearchManagement (RM) — Claude Guidance

> **Editing model (as of 2026-05-04):** this `/rm/` tree **is** the working
> source of truth for RM. Edit files here directly — do not edit the sibling
> `ResearchManagement/` repo's `js/`, `pages/`, `css/`. The old
> `deploy_to_rm_subdir.py` path-rewriting deploy is retired.

## What this repo is

A browser-based dashboard for PI lab management at the McGhee Lab,
University of Arizona. RM is the central hub that connects to sibling
GitHub repos for papers, proposals, courses, and tools. It ships under
`mcgheelab.com/rm/` (Cyberduck FTP from this McGheeLabWebsite repo to
godaddy).

## Architecture

- **Static HTML + vanilla JS, no framework, no build step, no npm.**
- All internal links use `/rm/...` absolute paths (e.g.
  `<link href="/rm/css/style.css">`, `<script src="/rm/js/util.js">`).
  Keep this prefix when adding new files — never introduce bare `/css/...`
  or `/js/...` (those exist for the parent McGheeLabWebsite SPA at the same
  origin and would collide).
- **Data layer:** Firestore is the production source of truth. The legacy
  JSON files in `../../ResearchManagement/data/` are seed/dev-mirror only
  and are not deployed to godaddy.
- **Adapter:** every data path is registered in
  [js/api-routes.js](js/api-routes.js); call sites use `api.load(path)` /
  `api.save(path, data)` from [js/util.js](js/util.js). The adapter at
  [js/api-firestore-adapter.js](js/api-firestore-adapter.js) routes to
  either `userData/{uid}/<subcollection>` (per-user) or a top-level lab
  collection (admin-write shared).

## Local dev

```bash
cd /Users/alexmcghee/Documents/GitHub/McGheeLabWebsite
RM_WRITE_ALLOWLIST=mcgheealex@gmail.com python3 rm/server.py
# open http://localhost:8000/rm/
```

[rm/server.py](server.py) is a thin launcher that hands off to
`../../ResearchManagement/server.py` (the real ~5000-line dev server with
all the API handlers). The sibling server mounts `/rm/*` back at this
McGheeLabWebsite repo's `rm/` tree so edits here are picked up live, while
`/api/data/*` still reads and writes `ResearchManagement/data/*.json` for
local seed JSON.

(Use the email tied to your Firebase admin Google account — for the
McGhee Lab that's `mcgheealex@gmail.com`, **not** the `@arizona.edu` work
address.)

The `RM_WRITE_ALLOWLIST` env var is a comma-separated email allowlist.
PUT requests to `/api/data/<path>` are refused unless the request carries
an `X-RM-User-Email` header (sent automatically by `js/util.js`'s
`api.save`) whose value matches an entry in the allowlist. Empty allowlist
= no JSON writes accepted at all. This is a pragmatic local-machine guard
against cross-user JSON contamination; the real security boundary in
production is firestore.rules.

## Production deploy

- **RM (this `/rm/` tree):** Cyberduck FTP the entire McGheeLabWebsite repo
  to godaddy. The `/rm/` subdirectory is what users hit at
  `mcgheelab.com/rm/`. There is no build step.
- **Firestore rules / indexes:** edit
  [../firestore.rules](../firestore.rules) and
  [../firestore.indexes.json](../firestore.indexes.json), then from the
  parent McGheeLabWebsite repo:
  ```
  firebase deploy --only firestore:rules
  firebase deploy --only firestore:indexes
  ```
- **Storage rules:** edit [../storage.rules](../storage.rules), then
  `firebase deploy --only storage:rules`.
- **Cloud Functions:** edit [../functions/](../functions/), then
  `firebase deploy --only functions`.
- Never paste rules into the Firebase console — the source of truth is the
  rules file in this repo and a console paste would be overwritten by the
  next deploy. Reuse the existing `isAdmin()`, `isLabMember()`,
  `isExtensionMember()`, `isLabContributor()` helpers at the top of
  `firestore.rules`; do not redefine them.

## Multi-tenant data layer

RM is multi-user. Every `data/<path>.json` has a Firestore route
registered in [js/api-routes.js](js/api-routes.js). Routes have:

- `scope: 'user'` — `userData/{uid}/<subcollection>` (per-user, no shadow
  to JSON).
- `scope: 'lab'` — top-level collection, admin-write, dual-writes to
  Firestore + JSON when `shadowJson: true`.

**Access policy:** anyone can sign in via Google, but guests have no RM
access until admin promotes them. Profile-bootstrap auto-creates
`users/{uid}` with `role: 'guest'`; firestore.rules' `isLabMember()`
requires `role != 'guest'`; firebridge renders a full-page
pending-access overlay for guest users until the role flips. Use
`firebridge.isLabMember()` (gate "can use RM at all") and
`firebridge.isAdmin()` (gate "can write shared lab data").

**Never bypass the adapter** — direct `fetch('/api/data/...')` calls leak
Alex's data to other lab members. If you need a new data category:

1. Add the route to [js/api-routes.js](js/api-routes.js) with
   `scope: 'user'` or `scope: 'lab'`.
2. Use `api.load` / `api.save` in the renderer — never bare-fetch the JSON
   path.
3. For admin-only views, gate the page with
   `firebridge.gateAdmin('reason')` in
   [js/firebase-bridge.js](js/firebase-bridge.js).
4. The migrate page at [pages/admin-migrate.html](pages/admin-migrate.html)
   walks the route table — admins migrate shared paths, any user migrates
   their own personal paths.

**Pages currently admin-gated** (until per-user Gmail/calendar OAuth lands):
[pages/email-review.html](pages/email-review.html),
[pages/calendar.html](pages/calendar.html). Their data sources
(`data/email_archive/`, `data/calendar_archive/`) are still lab-global
single-tenant.

**Routing details:** `shadowJson: true` on lab-scope routes means saves
dual-write Firestore + JSON; on user-scope routes shadow is OFF (avoids
cross-user JSON contamination). Discriminated collections (e.g. `funding`
with `kind: proposal|award|account`) use the route's `where` clause +
`discriminator` field stamping; the adapter chunks Firestore writes at
400 ops per batch.

## Conventions

- **Date format:** `YYYY-MM-DD` or the literal string `"TBD"`. Always.
- **IDs:** kebab-case slug (e.g. `prostate-gels-r01`, `mebp-paper`). Must
  be unique within a JSON file / Firestore collection.
- **Sibling repo references:** use `repo_path` (relative, e.g.
  `"../../ResearchManagement"` from McGheeLabWebsite/rm/) and/or
  `repo_org`. Don't duplicate content from sibling repos — link.
- **Sensitive data:** don't commit raw dollar amounts, SSNs, or tax docs
  even though this is a private workflow. Use external secure storage.

## Tasks: bucket + subtask model

Tasks live in the `tasks` Firestore collection (and mirror at
`../../ResearchManagement/data/tasks/buckets.json` for local dev) as a
three-tier tree:

- **Project bucket** (tier 1): user-created, free-form `title`, one per
  effort/initiative. Reserved `proj-inbox` (title "Proposed") holds
  suggestions that haven't been pinned yet.
- **Sub-bucket** (tier 2): carries `category` and `sub_category` (the
  former `pinned_buckets` concept, now nested inside a project). Reserved
  `buk-inbox-unfiled` lives under `proj-inbox`.
- **Subtask** (tier 3): checklist item. May nest via `children` up to 3
  levels deep. Carries `text, done, done_at, due_date, priority,
  hours_estimate, tracker_entry_id, evidence, notes, proposed, children`.

`evidence` at every level is `{email_ids:[], event_ids:[], item_ids:[]}`.
Due dates / hours / tracking live on every level; bucket+project roll up
their descendants.

Suggested subtasks from email-review, calendar, or the AI suggester are
written with `proposed:true` into `proj-inbox/buk-inbox-unfiled`. The user
pins them to a real bucket via the "Pin to…" menu, which clears
`proposed`.

The UI lives in [js/tasks-buckets.js](js/tasks-buckets.js) (main
workspace, loaded by [pages/tasks.html](pages/tasks.html)).

## PMR: 1:1 conversation surface (V3.159)

[js/pmr.js](js/pmr.js) + [pages/pmr.html](pages/pmr.html) is the canonical
admin↔student conversation surface — the structured doc the PI uses to
prep + run 1:1 discussions with each lab member. As of V3.159 it's not
just a worksheet: every block carries a threaded `💬 conversation`
toggle, and there are first-class **Barriers** and **Paper writing**
sections.

Sections render in `state.doc.section_order` (a string-key list); unknown
or missing keys fall back to `DEFAULT_SECTION_ORDER` and unknown keys
get appended to the end. Each block header carries `▲`/`▼` arrows
(V3.193) that swap positions in `section_order`. Every archivable
section (barriers, reference_links, project_overview, weekly_entries,
discussion, figure_reviews, paper_writing) splits items into a "new"
list (rendered inline) and an "archive" collapsed `<details>` with a
free-text search input, keyed on a uniform `discussed_at: ISO | null`
field per item; toggle button rendered via `buildDiscussedToggle`. The
Reference links block has a `⤓ Auto-fill from my work` button (V3.193)
that pulls in notebook entries + protocols + paper drafts + past PMRs +
grant drafts, deduped by URL+label.

Block lineup (the default order in [js/pmr.js](js/pmr.js)'s `DEFAULT_SECTION_ORDER`):

0. **Goals** (V3.186) — four time-horizon cards (this semester, this
   year, PhD journey, beyond PhD), each with rich-text body + per-
   horizon comment thread. Frames everything below, so renders first.
1. **Project overview** — table of active projects (status pill: good /
   behind / delayed / paused, status note).
2. **Open tasks** — read-only roll-up of subtasks where the viewed user
   is `assignee_uid && !done`, plus cross-user assignments at
   `userData/{me}/tasks` with `bucket=='assigned'`. (V3.189) Organized
   project → bucket → subtasks; each bucket header shows `N/M done` +
   a "✓ Mark complete" button when 100% of subtasks are done. Marking
   complete flips `bucket.archived=true` + `bucket.completed_at=now` on
   the per-project doc at `userData/{uid}/buckets/{projectId}`; archived
   buckets move to a collapsed "Archived buckets" section with a
   `↶ restore` affordance. Same lifecycle is mirrored on the Tasks page
   workspace ([js/tasks-buckets.js](js/tasks-buckets.js)). Owner-only
   today; admin cross-user mark-complete is a follow-up.
3. **Reference links** — notebooks, running notes, past PMRs, protocols,
   fellowship docs.
4. **Weekly entries** — date-ranged log; each week has a per-week thread.
5. **Barriers** — open / discussing / resolved lifecycle. Rich-text
   description (contentEditable + sanitize), paste-image upload via
   `PAPER_FIGURES.uploadImage`, linked-task chips, "+ Assign task" via
   `TASK_ASSIGN.open`, per-barrier discussion thread.
6. **Paper writing** — drafts where student is in `authorUids` and
   `is_library_entry !== true`. Status pill from `papers/{id}.status`,
   "open in builder" link, "+ task" button, per-paper thread.
7. **Discussion** — flat blocker / next-action / idea cards (legacy);
   each card now also has its own thread.
8. **Past PMRs** — read-only archive of legacy Google-Doc exports.

Storage:

- PMR doc: `userData/{ownerUid}/pmr/{periodId}` — student-owned, admin
  read+write, secondary researchers in `researcher_uids[]` also write.
  Schema: `goals: { short_term, this_year, phd, beyond_phd }` (each
  `{text_html, last_updated}`), `barriers[]`, `paper_writing[]`,
  `weekly_entries[]`, `project_overview[]`, `reference_links[]`,
  `discussion[]`, `figure_reviews[]`.
- Comments subcollection:
  `userData/{ownerUid}/pmr/{periodId}/comments/{commentId}` — fields
  `section_id`, `target_id?`, `body`, `authorUid`, `authorName`,
  `parentId`, `createdAt`, `modifiedAt`, `resolved`. Rule allows
  read+write by owner, admin, or comment author.
- Index: `userData/{ownerUid}/pmr/_index` — `{ periods: [{id,label,status,updated_at,archived?}] }`.
  V3.323: `archived: true` hides a period from the select (toolbar
  `🗃 N archived` toggle reveals them); the period doc also carries an
  optional `meeting_date: 'YYYY-MM-DD' | null` (1:1 date picker in the
  toolbar — reserved for FuturePlan 05 meeting reminders). V3.322:
  new periods are created via a guided dialog (semester chips +
  custom slug + copy-forward of goals / project overview / reference
  links from the latest period), and the current week auto-creates on
  period open / task pull.

Cross-user admin view: when an admin clicks another lab member in the
left rail, [js/pmr.js](js/pmr.js) reads the target's PMR via direct
`firebridge.db().collection('userData').doc(uid)...` refs (the api
adapter's `_userScopePath` hard-codes the signed-in uid, so cross-user
reads bypass it). Admin can read everything, post comments, assign tasks
— but cannot edit barriers, weekly entries, or project overview
(`isReadOnlyView()` short-circuits `scheduleSave`/`saveDoc`).

Threaded comments helper: [js/section-comments.js](js/section-comments.js)
exposes `SECTION_COMMENTS.mount({container, collectionPath, scope, label})`.
PMR uses it on every block; future features that want a per-block
conversation pane should reuse this helper rather than re-implement.

Tasks ↔ PMR sync bridge (V3.194): [js/task-pmr-sync.js](js/task-pmr-sync.js)
exposes `window.TASK_PMR_SYNC` with three functions:

- `addSubtaskToCurrentWeek(subtask, project, bucket)` — the Tasks page
  `＋ PMR` button on each subtask row uses this to push a copy into the
  most-recent PMR period's current week (auto-creates the week if
  needed), stamping `source_subtask_id` on the new item.
- `syncSubtaskDoneToPMR(subtaskId, isDone)` — fired by tasks-buckets's
  checkbox `change`, inline `Mark complete`, and `Undo completion`
  handlers. Scans current PMR period's weekly items for matching
  `source_subtask_id` and flips their status.
- `syncPMRItemDoneToSubtask(sourceSubtaskId, isDone)` — fired by PMR's
  `renderItem` status-change handler when the item carries a back-link
  and the change crosses the done/not-done line. Walks all of the
  user's bucket docs to find the source subtask and flips its `done`.

All three bypass the route adapter via direct `firebridge.db()` refs.
Both `pages/tasks.html` and `pages/pmr.html` load the script after
`task-assign.js`.

Task assignment from PMR: [js/task-assign.js](js/task-assign.js) accepts
`opts.source = 'pmr'` + `pmrPeriodId` + `pmrSectionId` + `pmrTargetId` +
`onCreated(task)`. PMR's "+ Assign task" buttons (on barriers and paper-
writing rows) call `TASK_ASSIGN.open()` with these prefilled — the new
task lands at `userData/{studentUid}/tasks/{taskId}` with the PMR backref
stamped, and `onCreated` back-links the task id onto the originating
barrier card.

## Training: lab-internal knowledge base (V3.162)

[pages/training.html](pages/training.html) is the landing page for the
RM Training section — a grid of self-paced modules covering scientific
communication, PhD expectations, microscopy, and image analysis. All
training pages declare `gate: 'lab-member'` in `nav.js`. Modules live at
flat slugs `pages/training-<slug>.html` with renderers at
`js/training-<slug>.js`. Shared styles in [css/training.css](css/training.css).
Curriculum + per-module plans in `CodeLog/ClaudesPlan/V3.162` – `V3.170`;
only `training-phd-triangle.html` is implemented today, the other eight
slugs are placeholders ("Coming soon" on the landing grid).

## Where things are in the McGheeLabWebsite parent repo

| Path | What it is |
|---|---|
| [../firestore.rules](../firestore.rules) | All Firestore security rules. Helpers at top: `isAdmin`, `isLabMember`, `isExtensionMember`, `isLabContributor`. |
| [../firestore.indexes.json](../firestore.indexes.json) | Composite indexes — add when a new query needs one. |
| [../storage.rules](../storage.rules) | File upload guards (paper PDFs, evidence, capture). |
| [../firebase.json](../firebase.json) | Deploy targets. RM is **not** Firebase-Hosting — it's FTP'd. |
| [../firebase-config.js](../firebase-config.js) | Shared Firebase init. |
| [../functions/](../functions/) | Cloud Functions used by RM (gmail-scraper, calendar-proxy, ics-scraper, stats-updater, oauth, chat, tasks). |
| [../user-system.js](../user-system.js) | Bootstraps `users/{uid}` profile that `isLabMember()` reads. Don't edit casually. |
| [../cv-builder.js](../cv-builder.js) | Shares `cvData/{uid}` with RM — keep [js/cv-schemas.js](js/cv-schemas.js) in sync. |

## How to add a new data category

1. Decide scope: per-user (`scope: 'user'`) or admin-write shared
   (`scope: 'lab'`).
2. Add route to [js/api-routes.js](js/api-routes.js).
3. Add a JS renderer in [js/](js/) (`<topic>.js`).
4. Add an HTML page in [pages/](pages/) (`<topic>.html`) — internal links
   use `/rm/...` absolute paths.
5. If it needs new Firestore paths, edit [../firestore.rules](../firestore.rules)
   and `firebase deploy --only firestore:rules` from the parent repo.
6. Add a summary card in [js/dashboard.js](js/dashboard.js).
7. Add a nav link in [js/nav.js](js/nav.js).
