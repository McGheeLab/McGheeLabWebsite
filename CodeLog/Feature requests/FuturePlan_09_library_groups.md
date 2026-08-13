# FuturePlan 09 — Library Groups Shelf (open-in-reader, pinned, reconfigurable groups)

> **Status: ✅ IMPLEMENTED (2026-07-13) as V3.363** — plan doc
> `CodeLog/ClaudesPlan/V3.363_library_groups.md`. Do NOT re-implement from this doc.
> Combined with FuturePlan 12's linkage work per Alex's request: the deferred
> "group from draft" idea shipped as a third group kind (`draft` — membership
> computed from `meta.library.linked_drafts`, the V3.352 LIBRARY_LINKS field),
> created via "＋ From draft". Deploy: `firebase deploy --only firestore:rules`
> (new `librarySharedGroups` collection) BEFORE the FTP push; sw.js 334→335.
> Still deferred: drag-and-drop, smart/draft lab groups, grant drafts in the
> from-draft picker, member-to-member group sharing.
> **Origin:** planning session 2026-07-12 (grill-then-plan interview with Alex; all
> design decisions below are user-approved). V3.350 was the expected slot at planning
> time; concurrent sessions took V3.350–V3.362, so it shipped as V3.363.

## Context

The RM library (`rm/pages/library.html` + `rm/js/library.js`) renders every paper as one
flat sorted table. As the library grows, finding "the papers I'm working with right now"
requires re-searching every visit. Alex asked (verbatim intent): *"propose nice ways to
make reconfigurable paper groups on the page to aid the user in quickly finding the
papers in their workflow. maybe a persistent section for papers that are open in the
reader. and a pinned papers section that is unique to each individual user."*

What exploration found (2026-07-12):

- The list is one flat table (`_render()` library.js:584, chunked rows at :649). The only
  grouping affordances today are the tag-chip strip (`_renderTagStrip` :678) and the
  missing-PDF filter. Papers already carry `meta.library.linked_drafts` (populated by the
  reader's link-to-draft picker) but the list page never consumes it.
- The multi-tab reader's open tabs live in `localStorage['rm_lp_open_papers']`
  (`LP_TABS_KEY` library-paper.js:25, payload `{tabs:[{id,title}], activeId}`, max 10
  tabs) — same-origin, so the library page can read it directly and live-update via the
  `storage` event.
- Ready-made per-user prefs home: `LIBRARY_PREFS` (rm/js/library-prefs.js) →
  `userSettings/{uid}.library`, frozen DEFAULTS (:21) + `_hydrate` deep-merge (:50) makes
  new keys back-compat safe. Already holds `pinned_tags`. Rules already allow owner
  read/write (firestore.rules:183-186) — zero rules changes for per-user data.
- Search grammar `_parseQuery` (:125) / `_matches` (:148) supports `tag:`, `author:`,
  `year:`, quotes, negation — a saved query string is a complete "smart group" definition.
- Group-UI precedents: chat.js sidebarLayout named groups w/ drag (:1161-1190),
  link-picker checkbox popover (`_openLinkPicker` paper-overlays.js:459), pmr.js
  `moveSection` ↑/↓ swap (:693), customize-modal widget checkboxes auto-rendered from
  `LIBRARY_PREFS.DEFAULTS.widgets_enabled` (library.js:1596).
- Existing shared `meta.library.starred` is lab-wide (on the item doc) — distinct from
  the requested per-user pin.

## Locked decisions (user-approved 2026-07-12)

1. **Groups = manual + smart.** Manual = hand-picked `paper_ids`; smart = a saved
   search-grammar query that auto-updates as matching papers arrive. Both render
   identically.
2. **Scope = per-user groups + admin-published lab-shared groups.** Members' groups are
   private; admins can publish lab-wide groups everyone sees (read-only for non-admins).
3. **Open-in-reader = this browser only.** Mirrors the reader's own localStorage tab
   state; no Firestore promotion, no cross-device merge policy needed.
4. **Layout = collapsible sections ("shelf") above the existing table.** The table stays
   untouched as the full searchable "All papers" list.

---

# Implementation plan

## Data model

### Per-user (no rules changes — `userSettings/{uid}` already owner-writable, firestore.rules:183)

Extend `LIBRARY_PREFS.DEFAULTS` in `rm/js/library-prefs.js` (verify array-of-objects pass
through the `Array.isArray` branch of `_hydrate` — fine, arrays are replaced whole on
save):

```js
pinned_papers: [],          // [paperId] — append order; render in order
paper_groups: []            // [{ id, name, kind: 'manual'|'smart',
                            //    paper_ids: [],      // manual only
                            //    query: '' }]        // smart only — raw search-grammar string
```

Smart-group `query` reuses the existing search grammar, so one string field covers
"query + tag prefix" with no second schema.

### Lab-shared groups (new)

- New top-level collection **`librarySharedGroups`** — docs shaped exactly like a
  `paper_groups` entry (`{id, name, kind, paper_ids, query}`).
- Route in `rm/js/api-routes.js`:
  `api.registerRoute('library/shared_groups.json', { scope:'lab', collection:'librarySharedGroups', wrapKey:'groups' })`
  — **no `shadowJson`** (new data, no legacy JSON to shadow).
- New block in `firestore.rules` next to other lab collections:
  ```
  match /librarySharedGroups/{groupId} {
    allow read: if isLabMember();
    allow write: if isAdmin();
  }
  ```
- No composite indexes needed (unfiltered collection read).

### Per-device state (localStorage, existing `rm_lib_*` convention)

- `rm_lib_shelf_collapsed` — JSON map `{sectionOrGroupId: true}` of collapsed states.
- Read-only consumption of the reader's `rm_lp_open_papers` key.

## Files added

### `rm/js/library-groups.js` — `window.LIBRARY_GROUPS` (new module, keeps library.js from bloating)

Public surface:
- `init(opts)` — called once from library.js boot. `opts` supplies the private helpers
  the module needs as callbacks:
  `{ getPapers(),                                    // visibility-filtered paper array (same list the table uses)
     parseQuery(q), matches(paper, parsed),          // library.js:125/:148
     isAdmin(),                                      // wraps library.js _isAdminAny (:1106)
     requestTableRefresh() }`
- `render()` — (re)renders the shelf into `#lib-groups-shelf`; called from `_render()` on
  every table re-render so counts/smart groups stay current.
- `isPinned(id)`, `togglePin(id)` — used by library.js row actions.
- `openGroupPicker(paperId)` — checkbox popover (pattern: `_openLinkPicker`,
  paper-overlays.js:459) listing the user's manual groups + (admins) shared manual
  groups; toggling membership writes `paper_ids`.

Internal responsibilities:
1. **📖 Open in reader section** — parse `rm_lp_open_papers`, render one compact chip per
   tab (title truncated, `activeId` highlighted), click → `library-paper.html?id=`.
   Hidden entirely when no tabs. Re-render on `window` `storage` event and on
   `visibilitychange` (returning from the reader tab).
2. **📌 Pinned section** — chips from `pinned_papers` resolved against `getPapers()`;
   each chip has a small ✕ (unpin). Hidden when empty.
3. **📁 Groups section** — user groups (in array order) then shared groups (small `lab`
   badge). Each group is a collapsible sub-row: header = name + kind badge (🔍 for smart)
   + count + controls; body = paper chips. Controls on owned groups (and on shared groups
   for admins): rename ✎ (rm-dialog prompt), delete 🗑 (confirm), ↑/↓ reorder (pmr.js
   `moveSection` swap pattern — simplest; skip drag-and-drop this version). Footer
   buttons: `＋ New group` (manual, name prompt); `＋ Lab group` visible to admins only.
   Manual-group chips get ✕ (remove from group).
4. **Smart-group evaluation** — `matches()` over `getPapers()` with the stored query,
   computed during `render()`; no persistence of results.
5. **Persistence** — user pins/groups via
   `LIBRARY_PREFS.save({pinned_papers, paper_groups})` (debounced merge-write already
   built); shared groups via `api.save('library/shared_groups.json', {groups})`
   (lab-scope full-replace batch).
6. **Dangling ids** — ids not present in `getPapers()` are silently skipped at render
   (no auto-clean writes); explicit unpin/remove still deletes the id.
7. **Search focus rule** — when library.js reports an active search query or tag filter,
   the whole shelf hides (`display:none`) so results are the focus; reappears when
   cleared.

### `rm/css/library-groups.css` (new topic file, repo convention like scheduler.css)

Shelf container, section header rows (one-line collapsed headers with counts), compact
paper chips (`flex-wrap: wrap`, title ellipsis, max-width), badges, mobile: chips wrap
full-width, controls stay tappable (min 32px targets). Keep it minimal per the
"focused tools" principle — no extra chrome.

## Files modified

- **`rm/js/library-prefs.js`** — add `pinned_papers`, `paper_groups` to DEFAULTS; add
  `widgets_enabled` keys `shelf_reader`, `shelf_pinned`, `shelf_groups` (customize modal
  auto-renders checkboxes from these — library.js:1596).
- **`rm/js/library.js`** —
  - boot: `LIBRARY_GROUPS.init({...})` passing `_parseQuery`, `_matches`, `_isAdminAny`,
    and a `getPapers` that returns the visibility-filtered list
    (`_applyVisibilityFilter`).
  - `_render()` (:584): call `LIBRARY_GROUPS.render()` and pass whether search/tag filter
    is active (drives the shelf-hide rule).
  - `_renderRow()` (:492): add two row-action buttons — 📌 pin toggle
    (`LIBRARY_GROUPS.togglePin`) and 📁 add-to-group
    (`LIBRARY_GROUPS.openGroupPicker`). Respect `widgets_enabled` toggles.
  - Toolbar: `💾 Save as group` chip rendered next to the count only while a search query
    or tag filter is active — captures the effective query (search input + active tag
    chip composed as a `tag:` token), prompts for a name, creates a smart group.
- **`rm/pages/library.html`** — `<div id="lib-groups-shelf"></div>` after the auth-hint /
  dropzone, before `.lib-toolbar`; add `/rm/js/library-groups.js` to `papersScripts`
  (before `library.js`, after `library-prefs.js` — the document.write block at :349);
  link `rm/css/library-groups.css`.
- **`rm/js/api-routes.js`** — register `library/shared_groups.json`.
- **`firestore.rules`** — `librarySharedGroups` block (above).
- **`sw.js`** — bump `CACHE_VERSION` (320 at planning time → re-check at ship).
- **CodeLog** — CHANGELOG entry; ARCHITECTURE.md new-module note for library-groups.js;
  plan copy in ClaudesPlan.

## Out of scope (defer)

- Drag-and-drop of papers into groups / drag-reorder (↑/↓ + picker popover cover it;
  chat.js drag pattern is the template if wanted later).
- Cross-device sync of reader tabs (open-in-reader stays per-browser by design).
- Sharing per-user groups member-to-member; group colors/icons; auto-groups by
  `linked_drafts` (natural follow-up: a one-click "group from draft" smart source).
- Any change to the existing shared `starred` field — star and pin coexist (star =
  shared lab signal, pin = personal).

## Release ritual (order matters)

1. Copy plan into `CodeLog/ClaudesPlan/`; implement; bump `sw.js` CACHE_VERSION;
   CHANGELOG + ARCHITECTURE.
2. **`firebase deploy --only firestore:rules` BEFORE the FTP push** — otherwise the new
   shared-groups read 403s for every lab member as soon as the new JS lands.
3. FTP (Cyberduck) the repo to GoDaddy.
4. `python3 scripts/version_push.py` (default minor bump) when Alex is ready to commit.

## Rollback

- Git revert + re-FTP (static tree). The rules block is additive and safe to leave
  deployed. Per-user prefs keys are inert under old code (`_hydrate` only reads keys
  present in DEFAULTS), so no Firestore cleanup needed. `librarySharedGroups` docs can be
  left in place or deleted manually — nothing else reads them.
- No irreversible writes: all new writes are additive prefs fields and a new collection.

## Open questions (flag during implementation, don't block)

- Should the pinned section cap (e.g. 20) to keep the shelf compact, or wrap freely?
  Default: no cap, chips wrap; revisit if it sprawls.
- Should smart groups evaluate against the visibility-filtered list (consistent with the
  table — chosen default) or the full library? Confirm with Alex if counts look
  surprising.
- `_isAdminAny` is module-private with an async admin-list warm-up (library.js:1106-1120)
  — if the shelf renders before the admin list resolves, the `＋ Lab group` button may
  need a re-render hook once `_adminListCache` settles (cheap: re-call
  `LIBRARY_GROUPS.render()` from the existing render path that already re-runs
  post-auth).

## Verification (manual, after FTP + hard refresh / SW update)

1. Open the reader, open 3 papers as tabs → back on the library page, the 📖 section
   shows 3 chips with the active one highlighted; close a tab in the reader (other
   browser tab) → library shelf updates without reload (storage event). Empty tabs →
   section hidden.
2. Pin 2 papers via the row 📌 → they appear in 📌 Pinned; reload → still there; sign in
   on another browser → pins follow (Firestore); a second lab account does NOT see them.
3. Create a manual group, add papers via the 📁 row action popover, remove one via chip
   ✕, rename, reorder with ↑/↓, delete — each survives reload.
4. Filter the table (search + a tag chip) → `💾 Save as group` appears; save → smart
   group with correct count; import/add a new paper matching the query → count grows on
   next render. Shelf hides while the search box is non-empty, returns when cleared.
5. As admin: create a lab group → visible (read-only, `lab` badge) to a non-admin
   account; non-admin sees no edit controls and no `＋ Lab group` button.
6. Customize modal: three new shelf toggles hide/show each section.
7. Mobile viewport: chips wrap, headers stay one line, all controls tappable.
8. Console clean of errors on library.html and library-paper.html (regression: reader
   untouched except its localStorage being read).
