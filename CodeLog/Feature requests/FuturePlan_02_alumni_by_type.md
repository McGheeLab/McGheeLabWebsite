# FuturePlan 02 — Alumni Grouped by Type (main site)

> **Status:** ✅ SHIPPED as V3.312 (2026-07-11) — see `CodeLog/ClaudesPlan/V3.312_alumni_by_type.md`.
> **Origin:** wishlist roadmap session, 2026-07-11.

## Context

Wishlist item: *"Alumni is by type: undergrad, masters, grad etc."* — the main-site team page currently shows one flat Alumni section.

What exploration found (2026-07-11): most of the machinery already exists.

- The team page already groups active members by `category` and `priorCategory` is **already stamped** on a user doc when their category flips to alumni (user-system.js ~lines 4823-4826, at planning time) and is already read for thesis labels (app.js ~line 653).
- The only taxonomy gap: `masters` is missing from `CATEGORIES`.
- The team page reads the `users` collection (not `teamProfiles`) — keep it that way.

## Locked decisions

- Add `masters` as a first-class category.
- The alumni section subdivides by `priorCategory` with display order: postdoc, grad → "PhD", masters, undergrad, highschool; missing/unknown `priorCategory` → generic "Alumni" bucket.
- One-time manual reclassification of existing MS alumni via the admin user editor (no migration script).

## Release 1 (the whole doc) — masters category + alumni subdivision

- Add `masters` to `CATEGORIES` (user-system.js ~lines 22-35) and `CATEGORY_DEFAULT_ROLE` (~line 38); insert into the team-page category order/labels (app.js ~lines 966-970, and the static list at ~lines 1855-1862).
- In `renderTeam` / the Firestore overlay path (app.js ~line 610+): when rendering the alumni group, sub-group members by `priorCategory` in the locked display order, each with a subsection header.
- Admin UI: the existing user-editor category dropdown picks up `masters` automatically from `CATEGORIES`; **verify `priorCategory` is editable in that editor** (add the field if not) so existing MS alumni can be reclassified once.
- styles.css: alumni subsection header styling consistent with existing category headers.

**Files:** app.js, user-system.js, styles.css. No firestore.rules / schema / index changes — both fields already exist on `users` docs.

## Release ritual

1. `CodeLog/ClaudesPlan/V{n}_alumni_by_type.md` before implementation. 2. CHANGELOG + ARCHITECTURE updates + sw.js CACHE_VERSION bump. 3. FTP only (no functions/rules deploy). 4. `python3 scripts/version_push.py`.

## Rollback

Client-only: git revert + re-FTP + CACHE_VERSION bump. Any `priorCategory` edits made through the admin editor are ordinary user-doc fields and harmless to leave.

## Open questions

None blocking. If someone was a masters student *and* later a PhD student before graduating, `priorCategory` holds only the last pre-alumni category — accepted.

## Verification

- Flip a test user to alumni from each prior category (grad, masters, undergrad, postdoc, highschool) → team page shows them under the right subdivided group.
- An existing alumnus with no `priorCategory` falls into the generic "Alumni" bucket (no crash, no empty header).
- Set a test user's category to `masters` while active → they appear in a Masters section among active members.
- Reclassify one real MS alumnus via the admin editor and confirm the public page updates.
