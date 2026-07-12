# RM Domain Glossary (CONTEXT.md)

> A living vocabulary for the McGhee Lab ResearchManagement app. Companion to
> [CLAUDE.md](CLAUDE.md): CLAUDE.md is for *rules* ("never bypass the
> adapter"), this file is for *names* ("a draft is a paper artifact under
> `papers/{id}/drafts/{draftId}`; don't call it a 'paper version'").
>
> Pattern adapted from Matt Pocock's CONTEXT.md in `mattpocock/skills`.
>
> When you discover a term being used inconsistently across the codebase, the
> answer goes here — not into a code comment.

## How to read each entry

- **Canonical term** — the name to use everywhere (file names, IDs, UI copy, code).
- **What it is** — the one-sentence definition.
- **Storage** — Firestore path if applicable.
- **Avoid** — synonyms or near-synonyms that are NOT to be used (they make grep + cross-file consistency worse).

---

## Tasks subsystem

### Project bucket
- **What it is** — Tier 1 of the task tree. User-created, free-form `title`, one per effort/initiative. Owns sub-buckets.
- **Storage** — `userData/{uid}/buckets/{projectId}`. ID format: `proj-*` (e.g. `proj-prostate-gels`, `proj-mebp-paper`). Reserved: `proj-inbox` (title "Proposed") holds suggestions before pinning.
- **Avoid** — "project", "initiative", "category" (these mean other things in adjacent surfaces). Always *project bucket*.

### Sub-bucket
- **What it is** — Tier 2 of the task tree. Carries `category` and `sub_category`. Nests under a project bucket. (Pre-V3.103 these were called "pinned buckets" — that term is retired.)
- **Storage** — Nested in the project bucket doc. ID format: `buk-*` (e.g. `buk-inbox-unfiled`).
- **Avoid** — "pinned bucket" (retired), "list" (Trello term), "category" alone (ambiguous with sub-bucket's `category` field).

### Subtask
- **What it is** — Tier 3 of the task tree. A single checklist item. May nest via `children` up to 3 levels deep.
- **Fields** — `text, done, done_at, due_date, priority, hours_estimate, tracker_entry_id, evidence, notes, proposed, children`.
- **Avoid** — "task" (ambiguous — could mean any tier), "item" (too generic), "todo" (not the lab's voice).

### `proposed` flag
- **What it is** — `proposed: true` on a subtask. Set by email-review, calendar, or AI suggester writes to `proj-inbox/buk-inbox-unfiled`. The user pins it to a real bucket via "Pin to…", which clears the flag.
- **Avoid** — "suggested", "draft task", "pending" (especially "pending" — see `users/{uid}.role: 'guest'` which renders a pending-access overlay; different meaning).

### `evidence` (on a subtask / bucket / project)
- **What it is** — `{email_ids:[], event_ids:[], item_ids:[]}` provenance. Present at every tier.
- **Avoid** — "sources", "links", "attachments".

### Assigned task
- **What it is** — A subtask where `assignee_uid !== authorUid`. Mirrors a copy at `userData/{assignee}/tasks/{taskId}` with `bucket = 'assigned'` so the assignee sees it in their inbox.
- **Avoid** — "delegated", "shared task".

---

## PMR subsystem (1:1 conversation surface)

### PMR
- **What it is** — The structured doc the PI uses to prep + run a 1:1 with a lab member. Acronym is internal — pronounce "P M R", don't expand in user-facing copy.
- **Storage** — `userData/{ownerUid}/pmr/{periodId}`.
- **Avoid** — "1:1 doc", "meeting notes", "agenda".

### PMR period
- **What it is** — One PMR document, identified by `periodId`. Each user typically has one current period and an archive of past ones.
- **Avoid** — "session", "round".

### PMR section
- **What it is** — A top-level block within a PMR (Goals, Project overview, Open tasks, Reference links, Weekly entries, Barriers, Paper writing, Discussion, Figure reviews, Past PMRs). Order controlled by `state.doc.section_order`.
- **Avoid** — "block" (overloaded: see Paper-builder block), "panel", "card" (overloaded: see UI cards).

### PMR item / PMR entry
- **What it is** — An individual record inside a PMR section. E.g. one barrier, one weekly entry, one project-overview row. Each carries a uniform `discussed_at: ISO | null` field so they can be archived consistently.
- **Avoid** — "row", "card", "record" (too generic).

### Goals (the section)
- **What it is** — Four time-horizon cards: `short_term, this_year, phd, beyond_phd`. Each `{text_html, last_updated}`. Frames the rest of the PMR, renders first.
- **Avoid** — "ambitions", "objectives", "OKRs".

### Barrier
- **What it is** — A blocker the student raises, with lifecycle `open → discussing → resolved`. Rich-text description, linked-task chips, per-barrier thread.
- **Avoid** — "issue", "problem" (less precise).

---

## Papers, drafts, library

### Library paper
- **What it is** — A paper-reader entry in the lab's literature library. Has `is_library_entry: true`. The reader page is `pages/library-paper.html?id=<paperId>`.
- **Storage** — `papers/{paperId}` with `is_library_entry: true`.
- **Avoid** — "reference", "citation entry", "publication" (when speaking of the lab's literature reading list — "publication" is used elsewhere for an authored paper).

### Paper draft
- **What it is** — A paper being authored by the lab. Has `is_library_entry !== true`. Edited via the Paper Builder.
- **Storage** — `papers/{paperId}` with `is_library_entry: false`, plus drafts at `papers/{paperId}/drafts/{draftId}`.
- **Avoid** — "manuscript", "paper version", "manuscript revision" — these all map to *draft*.

### Grant draft
- **What it is** — A grant being authored by the lab. Lives in `grantDrafts/{grantId}`. Visible in grant-builder URL as `?grant=<id>`.
- **Avoid** — "proposal" (ambiguous with the `funding` collection's `kind: proposal`), "submission".

### Paper overlay
- **What it is** — A set of highlights + comments layered onto a library paper, scoped to a specific draft or grant. The same paper can carry multiple overlays for different reviews.
- **Storage** — `papers/{paperId}/overlays/{overlayId}` plus `meta.library.linked_drafts: [draftId, ...]` on the paper doc.
- **Avoid** — "annotations" (we use the word "annotation" in the realtime-sync sense; overlays are the file-import flavor), "highlights" (incomplete — overlays carry highlights *and* comments).

### Overlay scope (`draft_id` vs `grant` vs `bucket_id`)
- **What it is** — Three aliases for the same internal field. `grant: <grantId>` (V3.187+, when scoping to a grant draft) and `draft_id: <paperDraftId>` (when scoping to a paper draft) are the canonical forms. `bucket_id: proj-*` is the legacy pre-V3.103 project-bucket scoping — only emit on explicit user request.
- **Avoid** — using two of these at once; pick one.

### Protocol
- **What it is** — A lab protocol (Matrigel, agarose LLS, etc.) authored in the Protocols Builder. Imported via the `/protocol-import` skill's JSON format.
- **Storage** — `protocols/{protocolId}` with version snapshots at `protocols/{protocolId}/versions/{vN}`.
- **Avoid** — "SOP" (the lab uses *protocol* in code; "SOP" only appears in some legacy doc titles).

### Formula block (inside a protocol)
- **What it is** — A `kind: 'formula'` block in the protocol tree that defines a named computation with variables. Step bodies reference its variables and output via `[!var:<name>]` tokens so changing inputs updates outputs everywhere.
- **Avoid** — "calculation", "equation" (use *formula* in code; *equation* may appear in user-facing copy but the code field is `formula`).

---

## Multi-tenant gating

### Lab member
- **What it is** — A user where `users/{uid}.role !== 'guest'`. Can use RM at all. Gate: `firebridge.isLabMember()`.
- **Avoid** — "member", "user" (both too ambiguous), "team member".

### Admin
- **What it is** — A user where `users/{uid}.role === 'admin'`. Can write shared lab data, view other members' PMRs cross-user, run migrations. Gate: `firebridge.isAdmin()`.
- **Avoid** — "PI" (one specific admin is the PI, but admin is the gating concept), "owner".

### Lab contributor
- **What it is** — Specific role used in `firestore.rules` for some write paths between member and admin. Helper `isLabContributor()`. Used sparingly; check the rules file before relying on it.
- **Avoid** — "editor", "writer".

### Guest
- **What it is** — A user with `role: 'guest'`, auto-assigned on first sign-in. Sees the full-page pending-access overlay until admin promotes them.
- **Avoid** — "visitor", "anon" (anonymous), "external" (overloaded with extension users).

### Extension member
- **What it is** — A user authorized to use the Chrome extension but not the full RM. Gate: `firebridge.isExtensionMember()`.
- **Avoid** — "Chrome user", "browser-extension user".

### Adapter (the API adapter)
- **What it is** — The `api.load(path) / api.save(path, data)` pattern from `js/util.js` that routes through `js/api-routes.js` to either Firestore or the local seed-JSON dev server. Never bypass it from page-level renderers.
- **Avoid** — "ORM", "data layer" (the data layer is Firestore; the adapter is the routing pattern), "client" (overloaded).

### `shadowJson`
- **What it is** — A per-route flag. `true` = `api.save` dual-writes Firestore + the local seed JSON (for `scope: 'lab'` routes that need a dev mirror). `false` = Firestore only.
- **Avoid** — "mirror", "shadow write" (use *shadowJson* in code; the spelled-out concept can appear in docs).

### Gate (verb / noun)
- **What it is** — Page-level access guard. Page declares `gate: 'lab-member'` or `gate: 'admin'` in `nav.js`. Renderers can also call `firebridge.gateAdmin('reason')` programmatically.
- **Avoid** — "guard", "permission check" — *gate* is the codebase's word.

---

## Activity / chat / huddle / training

### Activity entry
- **What it is** — A record in the activity-tracker stream (paper edits, calendar events, important-people conference dates, grant submit deadlines, etc.).
- **Avoid** — "event" (overloaded — calendar events are a different thing), "log entry".

### Huddle
- **What it is** — A scheduled lab-wide check-in surface (see `huddle.css`, `huddle.js`). Lighter-weight than a PMR — group, not 1:1.
- **Avoid** — "standup", "all-hands".

### Chat
- **What it is** — Lab-internal chat. Cloud function `functions/chat.js`, renderer `rm/js/chat.js`, page `rm/pages/chat.html`.
- **Avoid** — "messaging", "DMs" (DMs are a subset of chat, not the whole feature).

### Training module
- **What it is** — A self-paced page at flat slug `pages/training-<slug>.html` with renderer `js/training-<slug>.js`. Curriculum tracked in `CodeLog/ClaudesPlan/V3.162` – `V3.170`.
- **Avoid** — "course", "lesson" (lesson is a subset inside a module), "training page" (too generic).

---

## Release ritual

### sw.js CACHE_VERSION
- **What it is** — The integer cache key in `sw.js`. Every code change bumps it so PWA users get fresh code. Bumped automatically by `version_push.py` on release.
- **Avoid** — "service worker version" (the SW itself is one file; the cache version is the integer inside it), "cache buster".

### `version_push.py`
- **What it is** — `scripts/version_push.py`. The release ritual: pip-freeze, bump sw.js CACHE_VERSION, update CLAUDE.md version string, commit, push, create next `Version-X.Y` branch, push, switch.
- **Avoid** — "release script", "deploy script" (deploy is FTP, which is separate).

### FTP push
- **What it is** — Cyberduck FTP of this repo to godaddy. The actual deploy of `rm/` to `mcgheelab.com/rm/`. There is no build step.
- **Avoid** — "deploy" alone (ambiguous — could mean Firebase deploy of rules/functions), "publish".

### Firebase deploy (rules / indexes / functions)
- **What it is** — `firebase deploy --only firestore:rules` / `--only firestore:indexes` / `--only functions` / `--only storage:rules`. Server-side deploys, separate from the FTP push, and must run from the parent McGheeLabWebsite repo root.
- **Avoid** — Never paste rules into the Firebase console UI; the repo file is source of truth.

---

## Sibling repos

### Sibling repo
- **What it is** — A peer GitHub repo to McGheeLabWebsite, used as a content source. RM links to them via `repo_path` (relative, e.g. `"../../ResearchManagement"`) and/or `repo_org`. Sibling content is NOT duplicated into RM — RM links.
- **Examples** — `ResearchManagement/` (the legacy seed-JSON + dev server source), `Prostate GELS Proposal/`, `MEBP-Paper/`, `MRI Proposal/`.
- **Avoid** — "linked repo", "external repo".

### `repo_path` vs `repo_org`
- **What it is** — `repo_path` is a relative filesystem path from this repo. `repo_org` is the GitHub `org/repo` slug. A sibling reference may use one or both.
- **Avoid** — using full absolute paths in `repo_path` (they break on other machines).

---

## What does NOT go in this file

- Implementation details (those go in CLAUDE.md or in code comments).
- API signatures (those live in the code or in CodeLog/Architecture).
- Plan or changelog content (those live in CodeLog/).
- One-off term clarifications inside a single feature (those go in the feature's plan file).

When adding a term: confirm it's used in ≥3 places (code, UI, docs) and that you've seen at least one inconsistency that this entry resolves. If you can't think of an inconsistency, the term doesn't need to be here yet.
