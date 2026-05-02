# ResearchManagement Hub — Claude Guidance

## What this repo is

A browser-based dashboard for PI lab management at the McGhee Lab, University of Arizona. It is the central hub that connects to sibling GitHub repos for papers, proposals, courses, and tools.

## Architecture

- **Static HTML + vanilla JS** served by a thin Python server (`server.py`)
- **Data as JSON** in `data/` (legacy / dev-mirror) **AND in Firestore** (source of truth post-Phase-3). Every JSON file has a top-level key wrapping an array (e.g. `{"proposals": [...]}`). Never use a bare array as the top-level value.
- **No framework, no build step, no npm.** `server.py` is stdlib-only Python.
- **server.py** serves static files AND provides `GET/PUT /api/data/<path>` for reading/writing JSON from the browser. Used as a fallback for unmigrated paths and as a shadow-write target during migration cutover.

## Running server.py

```bash
RM_WRITE_ALLOWLIST=mcgheealex@gmail.com python3 server.py
```

(Use the email tied to your Firebase admin Google account — for the McGhee Lab that's `mcgheealex@gmail.com`, **not** the `@arizona.edu` work address.)

The `RM_WRITE_ALLOWLIST` env var is a comma-separated email allowlist. PUT requests to `/api/data/<path>` are refused unless the request carries an `X-RM-User-Email` header (sent automatically by [`js/util.js`](js/util.js)'s `api.save`) whose value matches an entry in the allowlist. Empty allowlist = no writes accepted at all. This is a pragmatic local-machine guard against cross-user JSON contamination; the real security boundary in production is firestore.rules. Reads are not gated since they fall back to migrated Firestore data via the adapter for any sensitive path.

## Multi-tenant data layer (post-Phase-3)

RM is no longer single-user. Every `data/<path>.json` has a Firestore route registered in [`js/api-routes.js`](js/api-routes.js); call sites use `api.load(path)` / `api.save(path, data)` from [`js/util.js`](js/util.js) and the adapter at [`js/api-firestore-adapter.js`](js/api-firestore-adapter.js) routes to either `userData/{uid}/<subcollection>` (personal) or a top-level lab collection (shared, admin-write).

**Access policy:** Anyone can sign in via Google, but guests have **no** RM access until admin promotes them. Profile-bootstrap auto-creates `users/{uid}` with `role: 'guest'`; firestore.rules' `isLabMember()` requires `role != 'guest'`; firebridge renders a full-page pending-access overlay for guest users until the role flips. Use `firebridge.isLabMember()` and `firebridge.isAdmin()` as the two relevant gates — `isLabMember()` is "can use RM at all", `isAdmin()` is "can write shared lab data".

**Never bypass the adapter** — direct `fetch('/api/data/...')` calls leak Alex's data to other lab members. If you need a new data category:

1. Add the route to `js/api-routes.js` with `scope: 'user'` (per-user) or `scope: 'lab'` (admin-write shared).
2. Use `api.load` / `api.save` in the renderer — never bare fetch the JSON path.
3. For admin-only views, gate the page with `firebridge.gateAdmin('reason')` in [`js/firebase-bridge.js`](js/firebase-bridge.js).
4. The migrate page at `pages/admin-migrate.html` walks the route table — admins migrate shared paths, any user migrates their own personal paths.

**Pages currently admin-gated** (until Phase 7 per-user Gmail/calendar OAuth): `pages/email-review.html`, `pages/calendar.html`. Their data sources (`data/email_archive/`, `data/calendar_archive/`) are still lab-global single-tenant.

**Routing details:** `shadowJson: true` on lab-scope routes means saves dual-write Firestore + JSON; on user-scope routes shadow is OFF (avoids cross-user JSON contamination). Discriminated collections (e.g. `funding` with `kind: proposal|award|account`) use the route's `where` clause + `discriminator` field stamping; the adapter chunks Firestore writes at 400 ops per batch.

## Conventions

- **Date format:** `YYYY-MM-DD` or the literal string `"TBD"`. Always.
- **IDs:** kebab-case slug (e.g. `prostate-gels-r01`, `mebp-paper`). Must be unique within a JSON file.
- **Sibling repo references:** Use `repo_path` (relative, e.g. `"../MEBP-Paper"`) and/or `repo_org` (GitHub org). Don't duplicate content from sibling repos — link to them.
- **Sensitive data:** Don't commit raw dollar amounts, SSNs, or tax docs even though this is a private repo. Use `accounts/` (gitignored) or external secure storage for those.

## How to add a new data category

1. Create `data/<topic>/<name>.json` with schema-carrying seed data
2. Add a JS renderer in `js/<topic>.js`
3. Add an HTML page in `pages/<topic>.html`
4. Add a summary card in `js/dashboard.js`
5. Add a nav link in `js/nav.js`

## When asked for rollups or reports

Read from the JSON files in `data/` — they are the source of truth. Don't scrape from HTML output.

## Sibling repos

Paths to sibling repos are stored in `data/projects/*.json` and `data/funding/proposals.json`. Read from those files to find repo locations — don't guess paths.

## Firebase rules — edit and deploy from McGheeLabWebsite

Firestore and Storage security rules are NOT in this repo. They live at:

- `/Users/alexmcghee/Documents/GitHub/McGheeLabWebsite/firestore.rules`
- `/Users/alexmcghee/Documents/GitHub/McGheeLabWebsite/storage.rules`

When this repo's code (paper builder, claims/evidence, annotations, capture extension, etc.) needs new Firestore paths or Storage paths, the rules MUST be edited in the McGheeLabWebsite repo and then deployed from a terminal there:

```
cd /Users/alexmcghee/Documents/GitHub/McGheeLabWebsite
firebase deploy --only firestore:rules     # or storage:rules
```

Never instruct the user to paste rules into the Firebase console manually — the source of truth is the rules file in McGheeLabWebsite, and a console paste would be overwritten by the next deploy. The existing `isAdmin()`, `isExtensionMember()`, and `isLabContributor()` helpers are already defined at the top of `firestore.rules`; reuse them rather than redefining.

## Tasks: bucket + subtask model

Tasks live in `data/tasks/buckets.json` as a three-tier tree:
- **Project bucket** (tier 1): user-created, free-form `title`, one per effort/initiative. Reserved `proj-inbox` (title "Proposed") holds suggestions that haven't been pinned yet.
- **Sub-bucket** (tier 2): carries `category` and `sub_category` (the former `pinned_buckets` concept, now nested inside a project). Reserved `buk-inbox-unfiled` lives under `proj-inbox`.
- **Subtask** (tier 3): checklist item. May nest via `children` up to 3 levels deep. Carries `text, done, done_at, due_date, priority, hours_estimate, tracker_entry_id, evidence, notes, proposed, children`.

`evidence` at every level is `{email_ids:[], event_ids:[], item_ids:[]}`. Due dates / hours / tracking live on every level; bucket+project roll up their descendants.

Suggested subtasks from email-review, calendar, or the AI suggester should be written with `proposed:true` into `proj-inbox/buk-inbox-unfiled`. The user pins them to a real bucket via the "Pin to…" menu, which clears `proposed`.

Legacy flat tasks still exist in `data/tasks/inbox.json` (read-only archive). To re-migrate (idempotent) run:

```
python3 scripts/migrate_inbox_to_buckets.py [--dry-run]
```

The UI lives in [`js/tasks-buckets.js`](js/tasks-buckets.js) (main workspace, loaded by [`pages/tasks.html`](pages/tasks.html)). `js/tasks-dashboard.js` and `js/tasks-inbox.js` still drive the legacy inbox/archive pages and have not yet been migrated.
