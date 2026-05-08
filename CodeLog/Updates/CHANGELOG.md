# Changelog

All notable changes to this project will be documented in this file.

Format: [Keep a Changelog](https://keepachangelog.com/)

## [V3.89] - 2026-05-08

**Popouts persist across workflow switches + page picker lists every page.** Reported: "when switching workflows, the side popouts both default to opened and they refresh. They should be loaded and stay loaded and their state should persist through anything we do in RM. Also the right popout menu does not have the correct dropdown to change the popout to a different page type."

### Three changes

#### 1. In-shell workflow switcher (popouts stay mounted)
Previously, switching workflows meant: shell → chooser (full page nav) → click another workflow card → shell again (another full page nav). Two reloads obliterated everything in the popouts.

- **`rm/js/nav.js`** — when `location.pathname === '/rm/pages/workflow-shell.html'`, the strip's brand becomes a hover-dropdown wrapper (`.ws-brand-dropdown`) instead of a plain anchor. Hover opens a menu listing all default workflows + the user's custom workflows + an "Open chooser…" footer.
- **`rm/js/nav.js`** — new `_wfPopulateBrandDropdown()` populates the menu after the workflow record loads. Pulls from `_wfDefaultsCache` + `_wfCustomCache`. Click a menu entry → dispatches `rm:shell:switch-workflow { workflowId, kind }`.
- **`rm/js/workflow-shell.js`** — listens for `rm:shell:switch-workflow`. Reconfigures in-place: `WorkflowState.setActive(id, kind)`, `replaceState` to update `?workflow=` + clear `?active=`, fetches the new workflow record, picks a landing page, calls `showActiveFrame(landing)` (lazy-creates a new iframe; old workflow's iframes stay mounted under `display: none` in the `_frames` map for instant return), refreshes the strip via `_wfRefreshStrip()`. **No page navigation occurs**, so the popouts (their iframes, scroll positions, in-progress edits) are untouched.
- **`rm/css/workflow.css`** — `.ws-brand-dropdown` + `.ws-brand-menu` + `.ws-brand-menu-item` styles. Hover-to-open like the regular `.nav-dropdown` pattern.

#### 2. Popout state persists in localStorage
URL is no longer the only source of popout state. Workflow switch via the chooser still works (full nav) and now restores the user's last popout config from localStorage.

- **`rm/js/shell-popouts.js`** — `readPersistedState()` / `writePersistedState()` read/write `localStorage['mcgheelab.shellPopout.state']` containing `{ leftPopout, rightPopout, leftOpen, rightOpen }`. `readState()` precedence is URL > localStorage > defaults. `writeState()` writes to BOTH URL and localStorage. So opening/closing a popout, swapping a page in a popout, or picking a different default page all stick across navigations and even browser restarts.

#### 3. Page picker lists every accessible page (grouped)
Was: workflow page IDs + chat + tasks. Many pages weren't reachable as a popout target.

- **`rm/js/shell-popouts.js`** — picker now uses `<optgroup>` sections: "This workflow" (workflow's pageIds), "Quick" (chat / tasks defaults if not already shown), then every other accessible page in `PAGE_REGISTRY.list` bucketed by NAV section (Activity / Research / Operations / Lab Admin / Settings / Other). `firebridge.canAccessPage` filter applied throughout.

### Other
- **`sw.js`** — `CACHE_VERSION` 63 → 64.

### Notes
- **Popout iframe persistence** is now true within a shell session (workflow switch via brand dropdown). Across the chooser route (full page nav), the iframe re-creates but at least its open/closed + page selection are restored from localStorage so the visible state matches the user's prior session.
- **Memory cost of in-shell workflow switching:** previous workflow's main iframes stay in DOM (`display: none`). Switching back is instant; cumulative footprint scales with how many distinct workflows the user visited in the session. Acceptable for typical 2–3 workflow sessions; could add LRU later if it bites.
- No firestore.rules / functions changes.
- **Hard-reload required** to evict SW cache `mcgheelab-shell-v64`.

## [V3.88] - 2026-05-08

**Bug fix — split panes showed nested workflow nav inside each iframe.** Reported: "now the split pages have their own workflow nav on each page header."

### Root cause

When the user clicked `⊟ Split` from inside the workflow shell, the strip's pre-fill code in `nav.js` set `leftURL` to `location.pathname + location.search + location.hash`. On the workflow shell, that's `/rm/pages/workflow-shell.html?workflow=…&active=…`. The split's left iframe then loaded **the workflow shell itself** — which boots its own `workflow-shell.js`, renders its own popouts, and lazy-loads its own active-page iframe. The user saw a workflow shell nested inside each split pane.

### Fix
- **`rm/js/nav.js`** — when `location.pathname === '/rm/pages/workflow-shell.html'`, the strip's split-link `leftURL` is now the **active workflow page's URL** (looked up from `?active=` + `pageMap` + `state.pageState[active]` for resume URL). Outside the shell (split-view, individual pages), behavior is unchanged: `leftURL = location.pathname + .search + .hash`.
- **`sw.js`** — `CACHE_VERSION` 62 → 63.

### Notes
- **Effect:** clicking ⊟ Split from the shell now opens split-view with `left=/rm/pages/library.html?paper=mebp` (the actual page), not `left=/rm/pages/workflow-shell.html?…`. The iframe loads the page directly with `?embed=1` + `name=rm-embed-left` so nav.js inside suppresses both regular nav and workflow strip — clean panes.
- Cmd-click on a chip in shell mode still opens the chip's full URL in a new tab (no behavior change there — the href stays valid).
- No firestore.rules / functions changes.
- **Hard-reload required** to evict SW cache `mcgheelab-shell-v63`.

## [V3.87] - 2026-05-08

**Chat-in-popout cleanup.** User reported chat in the side popout was confusing — Overview took precedence over the actual conversation, clicking conversations didn't load reliably, page-title and bottom bars stole vertical space the popout doesn't have. Targeted fixes in chat.js for embed mode.

### Background

Chat renders a `mobile` layout when `window.innerWidth ≤ 700px` (Overview / Chat / Files / Search tabs, one section at a time). Popouts default to 460px wide so they always trip the mobile threshold. The mobile layout was designed for full-screen phones; in a sub-panel it carried two pieces of chrome (page-title top bar + cross-app bottom bar) that were redundant and ate ~80–100 px of vertical space, AND defaulted `_mobileTab` to `overview` so users always landed on the channel list instead of the conversation they wanted to read.

### Changed
- **`rm/js/chat.js`** — `_IS_EMBED` constant computed once at module init from three signals: `window.parent !== window` (loaded inside an iframe), `window.name` matching `/^rm-(embed|shell)/` (set by V3.76 / V3.78 / V3.85 shell iframes), or `?embed=1` query (V3.73 fallback).
- **`rm/js/chat.js`** — `_mobileTab` default flips from `'overview'` to `'chat'` when `_IS_EMBED`. Users opening the chat popout land on their last conversation immediately; Overview is one tab tap away if they need to switch channels.
- **`rm/js/chat.js`** — `render()`'s mobile branch skips `renderMobileTopBarHTML()` and `renderMobileBottomBarHTML()` when `_IS_EMBED`. The popout's own header (page picker dropdown, close × button, drag-resize slider) handles "what is this" + "switch / close." Reclaims ~80 px of vertical space.
- **`rm/js/chat.js`** — `selectChannel(channelId)` now writes `localStorage['mcgheelab.chat.lastChannelId'] = channelId` on every selection. The channel-subscription bootstrap reads it and auto-picks that channel on first open if it still exists; falls back to the most-recent-activity channel as before. So reopening the chat popout returns to the same conversation across sessions.
- **`sw.js`** — `CACHE_VERSION` 61 → 62.

### Notes
- Embed-mode behavior is purely additive — chat outside a popout (full-page on `/rm/pages/chat.html`) keeps the original mobile / desktop layouts unchanged.
- `localStorage` last-channel persistence is per-browser, not synced across devices.
- No firestore.rules / functions changes.
- **Hard-reload required** to evict SW cache `mcgheelab-shell-v62`.

## [V3.86] - 2026-05-08

**Library paper reader gains four literature-review capabilities** — citations panel, project-bucket overlays, drag-drop `.paper-overlay.md` import, and highlight-aware in-paper search. Wishlist source: [rm/wishlist.md](../../rm/wishlist.md) lines 3–11. Plan: [V3.86_library_paper_overlays.md](../ClaudesPlan/V3.86_library_paper_overlays.md). Project buckets ([rm/js/links.js](../../rm/js/links.js)) are reused as the overlay key — no new entity invented.

### Added
- **`rm/js/paper-citations.js`** — left-sidebar "Citations on page N" panel. On `_viewer.ready()`, parses references from the back of the paper (heading match + hanging-indent split + DOI/year extraction). On every page change, regex-scans the page text for `[12]` numeric and `(Smith et al., 2020)` author-year tokens; renders one row per unique reference. Hover sidebar → flash on PDF; hover PDF token → highlight sidebar row. Expand row reveals full reference text + DOI link + **"+ Add to library"** button.
- **`rm/js/paper-overlays.js`** — overlay picker popover anchored at `#lp-overlays-anchor` in the right toolbar. Lists project buckets linked to this paper (`window.LINKS.linkedBucketsForItem`), each with a deterministic-color swatch + checkbox. All / None mini-buttons. State persisted at `localStorage.rm_lp_overlays_<paperId>`. Public API: `init`, `getActiveBucketIds`, `getFilterFn`, `getColorForBucket`, `getLinkedBuckets`, `onChange`.
- **`rm/js/paper-overlay-import.js`** — drag-drop a `.md` onto `#lp-viewer` to import highlights as bucket-scoped annotations. Banner appears on dragenter, modal on drop. Parser handles minimal YAML frontmatter (`paper_id` / `paper_doi`, `bucket_id`, `overlay_title`) + `## Highlight` blocks (`page`, `quote`, `color`, `comment` literal-block, `cite_in_drafts`, `evidence_stance`). Validation: paper-id strict-match, bucket existence (auto-link if not yet linked to paper), per-quote text-layer fuzzy-whitespace match. Preview modal lets the user de-select unmatched highlights; idempotent (skips existing `(quote, page, bucket)`).
- **`rm/js/paper-search.js`** — keyword search box at `#lp-search-anchor` in the right toolbar. Scans every page's text items, ranks hits inside existing highlight text-quotes first (page asc as tiebreak). Click a result → `_viewer.gotoPage(p)` + flash via `_flashRectOnPage`. Capped at 6 hits per page so a generic word doesn't return thousands.
- **`.claude/skills/paper-overlay/SKILL.md`** — Claude Code skill that authors `.paper-overlay.md` files in sibling VSCode lit-review repos (Prostate GELS, MEBP, MRI). Documents the format, behavior rules (verbatim quotes, lens-aware comments, no PII).
- **`rm/js/library-upload.js`** new `fromDoi(doi)` — looks up DOI via `LIBRARY_METADATA`, builds a paper item with no PDF, appends to `items.json`. Used by Phase 1's "+ Add to library" button. De-dupe by `meta.library.doi`.

### Changed
- **`rm/pages/library-paper.html`** — script tags for `links.js`, `paper-citations.js`, `paper-overlays.js`, `paper-overlay-import.js`, `paper-search.js`. New DOM slots: `<div id="lp-citations">` between `#lp-tags` and `#lp-metadata`; `<div id="lp-overlays-anchor">` and `<div id="lp-search-anchor">` as new toolbar rows.
- **`rm/js/library-paper.js`** — initializes each new module after `_mountViewer`; composes `PAPER_OVERLAYS.getFilterFn` AND with `ANNOTATION_PANEL.getFilterFn` in `_applyFilter`; stamps `bucket_ids: PAPER_OVERLAYS.getActiveBucketIds()` on new highlights via `ANNOTATION_OVERLAY.onCreate`; passes `getBuckets`/`getBucketColor`/`onBucketToggle` to `ANNOTATION_PANEL.init`; new helper `_flashRectOnPage(page, x, y, w, h)`; `_onPageChange` now also calls `PAPER_CITATIONS.refreshForPage(p)`; `onPageReady` callback also refreshes citations on the current page.
- **`rm/js/annotation-sync.js`** — `bucket_ids: []` added to create defaults so every annotation doc carries the field.
- **`rm/js/annotation-overlay.js`** — `_renderRectsForPage` now draws per-bucket left-edge stripes when `>1` overlay is active and the highlight has `bucket_ids`. Stripes are 3px wide, deterministic color from bucket id, only on the first rect of multi-line highlights.
- **`rm/js/annotation-panel.js`** — new optional opts `getBuckets`, `getBucketColor`, `onBucketToggle`; `_renderInfoPanel` grows an "Overlays" row of toggleable chips per linked bucket (orphan bucket ids in `bucket_ids` render as a non-clickable warning); chip click delegates to `onBucketToggle` (or falls back to a full `bucket_ids` patch via `onUpdate`).
- **`rm/css/style.css`** — styles for citations panel rows, overlay picker popover, per-bucket accent stripes + chips, drop banner, import modal, in-paper search results dropdown with `mark` highlighting.
- **`sw.js`** — `CACHE_VERSION` 60 → 61.

### Notes
- **Active-overlays state is localStorage, not Firestore.** Per-paper toggle state is ephemeral UI preference; per-paper Firestore prefs would be one read per paper open for no real benefit. (The plan-mode sketch had `paperPrefs` as a Firestore route; we simplified during implementation.)
- **`firestore.rules` was inspected, no edit required.** The annotations rule (line 505+) doesn't field-allowlist on owner writes — adding `bucket_ids` to a doc the creator owns just works. Non-creator updates are still restricted to `evidence_for_claim_ids`/`evidence_stance`/`modified` (the existing `hasOnly` clause), so non-owners can't change overlays on someone else's annotation. That's correct.
- **References parser is best-effort.** Numbered references with `[N]` or `N.` prefixes work cleanly; hanging-indent author-year lists work most of the time; column-broken references can split poorly. The cache key is `meta.library.references` on the paper item; if the parse looks wrong, hand-edit `items.json`.

## [V3.85] - 2026-05-08

**Side popouts now stick to the overall screen edges in both shell modes.** Reported: in workflow split, the popouts followed one of the iframes inside the split (because the workflow-shell URL was being passed AS the left iframe URL, so the workflow shell was nested inside the split — its popouts attached to that nested iframe's edges, not to the overall viewport). Fix: extract popout rendering into a shared module and load it on `split-view.html` too, so both shells render popouts as overlays on their own outermost host.

### Added
- **`rm/js/shell-popouts.js`** (~260 LOC) — shared module. `ShellPopouts.init(opts)` injects the two popout `<div>`s into a host element (idempotent — uses existing `#shell-popout-left` / `#shell-popout-right` if already present), reads/writes URL state for `?leftPopout`, `?rightPopout`, `?leftOpen`, `?rightOpen` (preserving every other URL param so it doesn't trample shell-specific params like `?workflow=` / `?active=` / `?left=` / `?right=`), persists per-side width to `localStorage`, and renders the two states (collapsed pill at viewport edge / open panel with header + iframe + drag-to-resize handle + close pill on slider).
- The page picker dropdown is restricted to `opts.workflowPageIds` plus the two defaults (`chat` + `tasks`), filtered by `opts.canAccessPage`.

### Changed
- **`rm/js/workflow-shell.js`** — refactored to delegate popouts to `ShellPopouts.init`. Removed all popout rendering / drag / state code (~140 LOC trimmed); `writeState()` no longer touches popout params. Boot calls `ShellPopouts.init({ container: #shell-root, workflowPageIds: wf.pageIds, … })` after the workflow loads. Behavior unchanged from the user's POV.
- **`rm/pages/workflow-shell.html`** — new `<script src="/rm/js/shell-popouts.js">` between workflow-state.js and workflow-shell.js.
- **`rm/pages/split-view.html`** — added `<link rel="stylesheet" href="/rm/css/workflow-shell.css">` (so popout styles are available), wrapped `<div id="split-root">` in a new `<div id="shell-root">` (the positioning anchor), and added `<script src>` tags for `page-registry.js`, `workflow-state.js`, `shell-popouts.js`.
- **`rm/js/split-view.js`** — after the IIFE renders the panes + writes initial state, calls `ShellPopouts.init({ container: #shell-root, workflowPageIds: <from sessionStorage workflow>, … })` on the next tick (so nav.js's `_wfAdoptFromUrl` has run and sessionStorage holds the workflow). Popouts now render on top of the split, anchored to the overall screen edges.
- **`rm/css/split-view.css`** — `body.has-split-view #shell-root { flex: 1 1 auto; position: relative; … }` makes the new wrapper the popout positioning anchor; `#split-root` keeps filling the wrapper. No visual change to the panes themselves.
- **`sw.js`** — `CACHE_VERSION` 59 → 60.

### Notes
- **Popout state shared via URL** — both shells use the same param names (`leftPopout` / `rightPopout` / `leftOpen` / `rightOpen`), no collision with split's `?left` / `?right` (which are full URLs for the iframe sources).
- **Width persisted via localStorage** — `mcgheelab.shellPopout.<side>Width`. The user's resized width follows them between workflow-shell and split-view.
- **No firestore.rules / functions changes.**
- **Hard-reload required** to evict SW cache `mcgheelab-shell-v60`.

## [V3.84] - 2026-05-08

**Bug fix — close pill on chat popout reloaded the iframe instead of closing the popout.** Reported: "when I click on the close chat popout, it just reloads the chat page and doesn't close the popout."

### Root cause

`writeState()` in workflow-shell.js only included `leftOpen` / `rightOpen` in the URL when truthy. On close:
1. `togglePopout(side, false)` → `writeState(s)` → URL drops the `leftOpen` param entirely
2. `renderPopout(side)` → `readState()` → URL has no `leftOpen`
3. V3.80's `readState` defaults missing `leftOpen` to **true** (so first-time visits open the popouts)
4. `renderPopout` sees `isOpen = true` → tears down + rebuilds the panel as if it's still open → new iframe gets a fresh src → chat reloads from scratch

The "default to open when missing" rule and "remove from URL when falsy" rule together made the close-state unrepresentable in the URL.

### Fix
- **`rm/js/workflow-shell.js`** — `writeState()` now ALWAYS writes `leftOpen` and `rightOpen` as literal `0` / `1` in the URL. Distinguishes "explicitly closed" (`0`) from "never visited" (param absent → still defaults to open).
- **`sw.js`** — `CACHE_VERSION` 58 → 59.

### Notes
- Click `×` in the panel header OR the chevron pill in the middle of the slider — both close the popout cleanly now.
- The pill at the viewport edge re-opens it (URL flips to `=1`); chat iframe is recreated on re-open (separate optimization to keep the iframe alive across toggle is queued).
- No firestore.rules / functions changes.
- **Hard-reload required** to evict SW cache `mcgheelab-shell-v59`.

## [V3.83] - 2026-05-08

**Bug fix — chip clicks in the workflow shell didn't switch pages.** Reported by user: "when I'm in a workflow, I can't switch pages." Root cause: a race between two writers of `?active=` in the URL.

### Root cause

V3.78's nav.js chip handler in shell mode did this on click:
1. `history.replaceState(...)` to set `?active=<newPageId>` on the URL
2. dispatch `rm:shell:set-active`
3. `_wfRefreshStrip()`

workflow-shell.js's listener then did:
```
const s = readState();   // reads URL — already has the NEW pageId
if (pageId === s.active) return;
```

So the listener early-bailed because `?active=` was already updated, and `showActiveFrame()` never ran → iframe never swapped → user clicks did nothing visible.

### Fix
- **`rm/js/nav.js`** — in shell-mode click handler, removed the URL `replaceState`. The listener in workflow-shell.js owns URL state via its own `writeState()` (which also dispatches `rm:split:state-change` listeners). CustomEvent dispatch is synchronous, so by the time `_wfRefreshStrip()` runs after `dispatchEvent`, the listener has already updated the URL and showActiveFrame has flipped the iframe; strip's chip-active class then reads the new `?active=` and lights up the right pill.
- **`sw.js`** — `CACHE_VERSION` 57 → 58.

### Notes
- Single source of truth: workflow-shell.js owns `?active=`. nav.js dispatches user intent.
- No firestore.rules / functions changes.
- **Hard-reload required** to evict SW cache `mcgheelab-shell-v58`.

## [V3.82] - 2026-05-08

**Workflow shell popouts get a close pill on the slider.** When a popout is open, the resize-slider on the inner edge now has a small chevron pill in the vertical middle. Click it → the popout retracts. Pairs with the existing collapsed-state pill (vertical floating tab at viewport edge) which extends; together they give one toggle affordance per side that's always reachable without going to the panel header.

### Changed
- **`rm/js/workflow-shell.js`** — `renderPopout()` open branch now appends a `.shell-popout-toggle.shell-popout-toggle--close` button alongside the resize handle. Glyph is `◂` for the left popout (closes-toward-left) and `▸` for the right popout. Click → `togglePopout(side, false)`. Both `pointerdown` (stopPropagation) and `click` (preventDefault + stopPropagation) are guarded so grabbing the pill never accidentally starts a resize drag.
- **`rm/css/workflow-shell.css`** — `.shell-popout-toggle`: 22×56 px capsule, `position: absolute; top: 50%`, anchored to the popout's inner edge with a per-side rounded-corner pattern (right side rounded for left popout, vice versa). White background + soft shadow so it visibly sits on top of the slider. Hover widens to 26 px and tints the icon. `z-index: 11` puts it above the resize handle so it captures clicks cleanly.
- **`sw.js`** — `CACHE_VERSION` 56 → 57.

### Notes
- The popout's header still has a `×` close button for users who navigate the panel content top-down. The slider pill is for users who want to toggle without reaching for the header.
- Closed-state pill (the larger vertical-text floating tab on the viewport edge) is unchanged — it remains the "extend" affordance when the popout is collapsed.
- **Hard-reload required** to evict SW cache `mcgheelab-shell-v57`.

## [V3.81] - 2026-05-08

**Workflow shell popouts are overlays now, not split panes.** V3.80 made the popouts flex items, which split the viewport into three columns (left popout / main / right popout). The user wanted FLOATING overlays so the main page never resizes — popouts slide in over the main content. Fixed by switching popouts to absolute positioning with a soft shadow.

### Changed
- **`rm/css/workflow-shell.css`** — `#shell-root` is now `position: relative` (not flex), and `#shell-main` is `position: absolute; inset: 0;` so main always fills the entire shell area regardless of popout state. `.shell-popout` is `position: absolute; top: 0; bottom: 0;` anchored to the appropriate edge with `z-index: 10`. When `.open`, the popout gets its width (default 460 px, user-resizable) + a soft drop shadow (`box-shadow: 0 0 24px rgba(15,23,42,.12)`) so the floating-layer affordance is visible. Wrapper is `pointer-events: none` when closed; pill + open panel are `pointer-events: auto` so they're clickable but don't block clicks on the main iframe.
- **Compact pill** (collapsed state) — was a full-height 40 px bar splitting the viewport. Now a small **32×120 px floating tab anchored at mid-height** on the appropriate edge, with rounded corners on the inner side and a small shadow. Hover slightly widens to 36 px for affordance. Vertical rotated label + icon. Replaces the V3.80 full-height pill so collapsed popouts don't visually take real estate from the main page.
- **`rm/css/workflow-shell.css`** — left popout pill: `border-radius: 0 10px 10px 0`; right popout pill: `border-radius: 10px 0 0 10px`. Borders flipped on `.open` state so the seam is on the appropriate side.
- **`sw.js`** — `CACHE_VERSION` 55 → 56.

### Notes
- **No JS changes** — the popout open/close + resize-drag + width persistence (V3.80) all still work; only the visual layout changed.
- **Trade-off**: when both popouts are open and total ≥ viewport width, they'll overlap each other visually. Acceptable on desktop (viewport > 1000 px is typical); mobile already has a separate overlay rule via the `@media (max-width: 800px)` breakpoint.
- **Hard-reload required** to evict SW cache `mcgheelab-shell-v56`.

## [V3.80] - 2026-05-08

**Workflow shell fixes — popout sizing + load order regression.** Three bugs reported on V3.78's shell; all fixed.

### Bugs fixed

#### 1. `[page-registry] NAV_ITEMS not in scope` — main page wasn't loading
- **`rm/pages/workflow-shell.html`** — V3.78 loaded `page-registry.js` BEFORE `nav.js`. page-registry.js reads `NAV_ITEMS` from nav.js's top-level scope, so it warned and bailed → `PAGE_REGISTRY` never built → `workflow-shell.js` couldn't render anything → blank page. Swapped the order: nav.js → page-registry.js → workflow-state.js → workflow-shell.js. Comment in HTML flags the dependency.

#### 2. Popouts didn't show by default
- **`rm/js/workflow-shell.js`** — `readState()` previously defaulted `leftOpen` / `rightOpen` to `false`, so chat + tasks were collapsed pills on every shell entry and the user had to click them to see anything. Defaults now flip to `true` (open) on first load — chat shows on the left, tasks on the right, immediately. URL params still override (so `?leftOpen=0` collapses on entry).

#### 3. Popouts too small + couldn't be resized
- **`rm/js/workflow-shell.js`** — bumped `DEFAULT_POPOUT_WIDTH` 380 → **460 px** for actual usability (chat + task lists need real width).
- **`rm/js/workflow-shell.js`** — added a per-side **drag-to-resize handle** on the popout's inner edge (right edge of left popout; left edge of right popout). Pointer-down on the handle starts a drag; pointermove updates the popout's width inline; pointerup persists the final width to `localStorage` under `mcgheelab.shellPopout.<side>Width` (clamped 240–900 px). Iframe pointer events are suppressed during the drag so the iframe doesn't capture the pointermove (same trick `split-view.js` uses for the divider).
- **`rm/js/workflow-shell.js`** — `applyPopoutWidth(side)` reads the saved width on render and applies it inline. `readPopoutWidth(side)` falls back to the default + clamps; persisted width survives page reloads, workflow switches, and across devices (well — `localStorage` is per-browser; cross-device sync would require Firestore — out of scope).
- **`rm/css/workflow-shell.css`** — `.shell-popout.open` now `position: relative` so the absolute-positioned resize handle anchors correctly. `.shell-popout-resize` rules: 6 px wide, full-height, `cursor: col-resize`; turns subtle blue on hover or while dragging. `body.shell-popout-resizing` suppresses iframe pointer events.

### Other
- **`sw.js`** — `CACHE_VERSION` 54 → 55.

### Notes
- **`localStorage` (not session)** for popout width — admin's preferred size sticks across browser restarts. URL still owns ephemeral state (which page is in each slot, whether each is open).
- **No firestore.rules / functions changes.**
- **Hard-reload required** to evict SW cache `mcgheelab-shell-v55`.

## [V3.79] - 2026-05-07

**Bulk grant/revoke + sort by role on the Users × Pages admin matrix.** Setting permissions for many lab members one cell at a time was painful. Two upgrades:

1. **Bulk-action bar.** Tick row checkboxes on the users you want to update, tick page chips for the pages to apply, then click `Grant pages to selected users` (adds) or `Revoke pages from selected users` (removes). Status line reports `(N cells changed)` so admin can see the scope before saving.
2. **Sort users by role.** Default is "Role then name" — clusters admins, postdocs, PhDs, etc. together. Other options: by name, by email. Each user row also gets a small color-coded role tag next to their name for visual scanning.

### Changed
- **`rm/js/admin-permissions.js`** —
  - `sortUsers()` factored out of `loadUsers()`. Reads `#perm-user-sort` value; default is `'role'` which uses a `ROLE_ORDER` rank (`admin > pi > postdoc > phd > masters > undergrad > staff > collaborator > member > guest`) with name as tiebreaker.
  - `renderUserGrid()` calls `sortUsers()` first so re-rendering after a sort change is correct. Each row's label cell gained a `<input class="perm-user-select">` checkbox + a `<span class="perm-role-tag perm-role-<role>">` chip next to the name. Cell checkboxes now overlay pending edits on top of `initialState` so re-rendering during a bulk apply preserves what the admin just toggled.
  - New module-level state: `selectedUsers: Set<uid>`, `bulkPages: Set<pageId>`.
  - New handlers: `onUserSelectToggle`, `onBulkPageToggle`, `onBulkSelectAll`, `onBulkClearSelection`, `onBulkClearPages`, `onBulkApply(mode)`. The apply path mutates DOM checkboxes + dispatches synthetic `change` events so the existing `onUserCellChange` flow tracks each flipped cell as a pending edit.
  - `refreshBulkBar()` builds the page picker chips lazily on first show and syncs the visual state on every selection change.
  - `wireActions()` now also wires the sort dropdown + the five bulk-bar buttons.
- **`rm/pages/admin-permissions.html`** — new `.perm-users-toolbar` (sort dropdown + hint), new `#perm-bulk-bar` (3 rows: count + select-all/clear; pages picker; grant/revoke buttons). CSS for `.perm-user-label`, `.perm-user-select`, `.perm-role-tag` (one rule per role with its own color), `.perm-bulk-bar`, `.perm-bulk-chip` (with `.on` state). Workflows tab unaffected.
- **`sw.js`** — `CACHE_VERSION` 53 → 54.

### Notes
- **Save flow unchanged.** Bulk apply just generates pending cell edits; `Save changes` (top toolbar) flushes them per the existing `userPermissions/{uid}` write path.
- **No firestore.rules / functions changes.**
- **Hard-reload required** to evict SW cache `mcgheelab-shell-v54`.

## [V3.78] - 2026-05-07

**Workflow shell — every workflow page is always loaded, with side popouts.** Two coupled features the user asked for:

1. **All workflow pages stay loaded.** Entering a workflow now lands the user on a single shell page (`rm/pages/workflow-shell.html`); each workflow page becomes an iframe inside it. The first chip click on a not-yet-visited page lazy-creates that iframe; subsequent visits to any chip just toggle DOM visibility (no reload, no data refetch). State (paper id, scroll, in-progress edits) survives chip switching.
2. **Side popouts.** Two collapsible panels (left + right) hugging the edges of the shell. Each is a small vertical pill (40px wide) when collapsed; clicking opens a 380px-wide panel with an iframe of the user's chosen page. Defaults: **left = Chat, right = Tasks**. A small dropdown in each popout's header swaps the page in that slot. URL persists `?leftPopout`, `?rightPopout`, `?leftOpen`, `?rightOpen`.

Cross-iframe consistency: handled by Firestore's existing live-sync (LIVE_SYNC.attach in each renderer) — when iframe A writes, iframe B's listener fires the same way it does for cross-tab updates. No new state-coordination machinery was needed.

### Added
- **`rm/pages/workflow-shell.html`** — single-page host for an entire workflow. Top: workflow strip (rendered by nav.js, shell-aware). Body: `#shell-popout-left` / `#shell-main` / `#shell-popout-right` row.
- **`rm/js/workflow-shell.js`** (~280 LOC) — orchestrates iframe lifecycle:
  - `readState()` / `writeState()` — single source of truth in URL: `?workflow=<id>&active=<pageId>&leftPopout=<pageId>&rightPopout=<pageId>&leftOpen=<0|1>&rightOpen=<0|1>`.
  - `loadWorkflow(id)` — Firestore (`labConfig/defaultWorkflows`) → seeds (PAGE_REGISTRY.DEFAULT_WORKFLOWS) → `userData/{uid}/customWorkflows/{id}` fallback chain.
  - `ensureFrame(pageId)` — lazy-creates an iframe for a workflow page, sets `name="rm-shell-<pageId>"` (V3.76 mechanism extended to also recognize `rm-shell-` prefix in nav.js suppression — already covered by the `rm-embed` prefix check).
  - `showActiveFrame(pageId)` — flips `display` between iframes; first-time activation creates the iframe.
  - `renderPopout(side)` — collapsed pill or open panel + iframe. Page picker dropdown lets the user pick which page goes in this slot. Restricted to workflow pages + chat/tasks (always available).
  - Listens for `rm:shell:set-active` events from the strip's chip clicks.
- **`rm/css/workflow-shell.css`** (~150 LOC) — vertical body flex; `#shell-root` horizontal flex with two popouts hugging edges; `.shell-popout-pill` (collapsed vertical bar with rotated label); `.shell-popout-header` + `.shell-popout-frame` (open state). Mobile fallback: open popouts overlay the main pane.

### Changed
- **`rm/js/nav.js`** — `renderWorkflowStrip` detects shell mode (`location.pathname === '/rm/pages/workflow-shell.html'`). In shell mode:
  - Active chip is determined by `?active=<pageId>` (not pathname/tab matching).
  - Chip click is captured (`e.preventDefault()`) and dispatches `rm:shell:set-active { pageId }`. URL updated via `history.replaceState`. Strip refreshes via `_wfRefreshStrip` so the active class moves.
  - Suppression check (`window.name`) already accepts the `rm-shell-` prefix because the existing check uses `indexOf('rm-embed') === 0` — needs an update? Actually no, the V3.76 check is `indexOf('rm-embed') === 0` which won't match `rm-shell-*`. **This file's renderNav embed-suppression line 357 needs to also accept `rm-shell-` prefix** — fixed in this commit by using a generic 'rm-' prefix detection (`/^rm-(embed|shell)-/.test(window.name)`).
- **`rm/js/workflow-chooser.js`** — both default-card and custom-card click handlers route through the workflow shell (`/rm/pages/workflow-shell.html?workflow=<id>&active=<landingPageId>`) instead of the landing page directly.
- **`sw.js`** — `CACHE_VERSION` 52 → 53.

### Notes
- **No firestore.rules / functions changes.** Workflow shell uses existing data paths (`labConfig/defaultWorkflows`, `userData/{uid}/customWorkflows`, `users/{uid}.allowedPageIds`).
- **Memory cost** — each iframe is ~5MB. Typical workflow has 5–7 pages, so peak footprint is ~25–35MB beyond the parent. Manageable on modern devices.
- **First-paint cost** — only the landing iframe loads on shell entry. Other iframes lazy-load on first chip click. Subsequent chip clicks are instant.
- **Direct page links from outside the shell** (e.g., a deep link to `/rm/pages/library.html`) still work and bypass the shell. Workflow context is preserved via sessionStorage if the user previously entered a workflow.
- **Split view** still works as before. From inside the shell, the strip's `⊟ Split` button takes the user to `split-view.html` (leaves the shell). No nested shell-in-split or split-in-shell — out of scope.
- **Hard-reload required** to evict SW cache `mcgheelab-shell-v53`.

## [V3.77] - 2026-05-07

**Editable workflow meta + add/delete in the admin matrix.** The Default Workflows × Pages tab at `admin-permissions.html?tab=workflows` previously showed each workflow's icon, name, and id as static text — only the page-membership checkboxes and landing-page select were editable. Admins can now also rename workflows, change icons, edit descriptions, add brand-new workflows, and delete existing ones — all from the same grid.

### Changed
- **`rm/js/admin-permissions.js`** — split the workflow-row rendering into `buildWorkflowRow(wf)`. Each row's label cell now contains:
  - `<input class="perm-wf-icon">` — single-emoji/character picker (maxlength=2 for surrogate-pair emojis like 📊).
  - `<input class="perm-wf-name">` — workflow display label.
  - `<input class="perm-wf-desc">` — short description shown on the chooser card.
  - Workflow id (read-only, monospace).
  - Landing-page select (V3.66, unchanged).
  - `<button class="perm-wf-del">×</button>` — delete confirm dialog.
- **`rm/js/admin-permissions.js`** — new `onWorkflowMetaChange()` handles input → tracks one pending edit per `(workflowId, field)` keyed `workflow-meta:<wfId>:<field>`. Lazy-initializes `wf._initialMeta` on first edit so subsequent saves can compare against the loaded baseline.
- **`rm/js/admin-permissions.js`** — new `onAddWorkflow()` triggered by the new bottom row. Slugifies the typed name to an id, validates uniqueness, appends a fresh workflow record with empty pageIds, and re-renders. Three pending edits (icon/label/description) are seeded so Save flushes the new workflow even if admin saves immediately.
- **`rm/js/admin-permissions.js`** — new `onDeleteWorkflow(wfId)` with confirm dialog. Drops the workflow from `defaultWorkflows`, scrubs any pending edits scoped to it, and adds a `workflow-deleted` sentinel so Save fires.
- **`rm/js/admin-permissions.js`** — `saveAll()` extended to recognize `workflow-meta` and `workflow-deleted` edit types as triggers for the doc write. After save, refreshes both `_initialLanding` and `_initialMeta` baselines per workflow so further edits compare correctly.
- **`rm/pages/admin-permissions.html`** — new CSS rules for `.perm-wf-meta`, `.perm-wf-row1`, `.perm-wf-icon`, `.perm-wf-name`, `.perm-wf-desc`, `.perm-wf-del`, `.perm-add-row`. Inputs get `:focus` ring; delete button only colors red on hover; add row gets a subtle blue tint to distinguish it.
- **`sw.js`** — `CACHE_VERSION` 51 → 52.

### Notes
- **No firestore.rules / functions changes.** The doc shape gained no new fields — `label`, `description`, `icon`, `landingPageId`, `pageIds` were already serialized; admins just couldn't edit name/icon/description from the UI before.
- **Workflow ids are immutable** in this UI. Renaming changes the display label only. Changing the id would require migrating every user's `customWorkflows` and `pageState` references — out of scope; admins should delete + re-add instead (with confirm).
- **Hard-reload required** to evict SW cache `mcgheelab-shell-v52`.

## [V3.76] - 2026-05-07

**Split-view navigation robustness — three fixes that together stop iframes from spawning their own nav.** User reported a confusing failure: in Lab Research workflow → split → click a paper in the library iframe → the new library-paper page rendered its own non-workflow nav inside the iframe (the parent strip was unchanged, but the user read the appearance/disappearance as "new workflow nav bar appeared"). Root cause: in-iframe `<a href>` clicks navigate to URLs without `?embed=1`, so the next document's nav.js saw no embed signal and rendered the regular non-workflow nav. Plan doc: [CodeLog/ClaudesPlan/V3.76_split_nav_robustness.md](../ClaudesPlan/V3.76_split_nav_robustness.md).

### Changed

#### 1. `window.name` as a durable embed signal
- **`rm/js/split-view.js`** — `paneHTML()` now adds `name="rm-embed-<side>"` to each iframe element when `_HAS_WORKFLOW`. The browsing context name SURVIVES navigations within the same frame per the HTML spec, so even after an in-iframe `<a href>` click that drops `?embed=1`, the new document still inherits the name.
- **`rm/js/nav.js`** — `renderNav()` checks `window.name.startsWith('rm-embed')` BEFORE the existing `?embed=1` URL check. Either signal triggers suppression. The two together are belt-and-suspenders: name is the durable cross-navigation signal, query is the initial-load + defense-in-depth signal.

#### 2. Iframe URL sync to parent split state on `load`
- **`rm/js/split-view.js`** — new `wireIframeLoad(side)` attaches a `load` listener to each `.split-pane-frame`. On every load (including in-iframe navigations), the handler reads `iframe.contentWindow.location.pathname + .search + .hash`, strips `?embed=1`, and updates `state[side]` if it differs. `writeState()` already dispatches `rm:split:state-change` (V3.75) → strip refreshes → chip "open" markers re-match against the new URL.
- **Effect:** when the user clicks a paper in the library iframe, the strip sees `state.left` change to `library-paper.html?id=X` and the Library chip's green dot disappears. If they navigate to a different workflow page in the iframe, the corresponding chip lights up.

#### 3. Strip `?embed=1` from saved state URLs
- **`rm/js/split-view.js`** — new `_stripEmbed(href)` helper. `writeState()` normalizes `state.left` / `state.right` before serializing to the URL, so the parent's URL bar never carries the iframe-internal `?embed=1` artifact. `wireIframeLoad()`'s sync also strips before saving. Result: closing split takes the user to a clean URL like `/rm/pages/library-paper.html?id=X`, no `?embed=1` suffix.

### Other
- **`sw.js`** — `CACHE_VERSION` 50 → 51.

### Notes
- **No firestore.rules / functions changes.** Pure frontend.
- **Out-of-workflow split unchanged.** Iframes don't get `name="rm-embed-..."` (only set when `_HAS_WORKFLOW`), so they render their full RM nav inside — users can navigate within each pane independently. The strip-driven swap UX is workflow-only by design.
- **CustomEvent bridge unchanged.** `rm:split:swap` / `:set-active` / `:close` / `:state-change` from V3.75 still work; iframe-load sync just calls `writeState()` to fire `:state-change` for free.
- **Hard-reload required** to evict SW cache `mcgheelab-shell-v51`.

## [V3.75] - 2026-05-06

**Split view redesign — single nav, two pages.** The pane headers (per-pane dropdown + reload + open-full + close buttons) are gone. The workflow strip on the parent IS the navigation: pills show every workflow page, the two pills matching the open panes get a colored side dot (🟢 left, 🔵 right), and the active pane's pill gets a red outline. Click a closed pill → swaps it into the active pane. Click an open-but-not-active pill → that side becomes active (red outline jumps over). Click a pane in the iframe → also makes that pane active (mousedown bridges to `setActive`). A new "× Close split" button replaces "⊟ Split" in the strip when on `split-view.html` — exits to the active pane's URL.

### Changed
- **`rm/js/split-view.js`** — rewritten:
  - Removed pane-header markup (`.split-pane-header`, `.split-pane-select`, `.split-pane-label`, `.split-pane-actions`, `.split-pane-btn`).
  - URL state gained `active=<left|right>`; default 'left'. Persisted via `history.replaceState` like before.
  - Listens for `rm:split:swap`, `rm:split:set-active`, `rm:split:close` CustomEvents on `window` (dispatched by nav.js's strip pill clicks).
  - `swapPane(side, href)` swaps an iframe src in place (no full re-render); also flips active to the swapped side.
  - `setActive(side)` toggles `.active` class on the corresponding `.split-pane`.
  - `closeSplit(keep)` navigates the parent to the surviving pane's URL.
  - Mousedown on a pane (capture phase) → `setActive(side)`.
  - Each `writeState()` dispatches `rm:split:state-change` so the strip re-renders to reflect open/active state.
  - `?embed=1` is now applied to iframe URLs ONLY when a workflow is active. Outside a workflow, iframes load their full RM nav so the user can navigate within each pane (the strip isn't there to swap pages for them).
- **`rm/js/nav.js`** — `renderWorkflowStrip()` gained split-mode awareness:
  - Reads `?left`, `?right`, `?active` from URL when on `/rm/pages/split-view.html`.
  - For each chip, computes `openSide` ('left' | 'right' | null) by matching pathname + `?tab` against the pane URLs. Adds `.ws-page-open` + `.ws-page-open--<side>` classes; `.ws-page-active-split` on the open chip matching `active`.
  - In split mode, chip click is captured (`e.preventDefault()`) and dispatches the appropriate event:
    - Closed pill → `rm:split:swap` with side=active, href=baseHref.
    - Open-non-active pill → `rm:split:set-active` with the open side.
    - Open-active pill → no-op (already active).
  - "⊟ Split" button replaced by "× Close split" when on split-view.html.
  - `rm:split:state-change` listener at file scope re-renders the strip when `swapPane` / `setActive` write new URL state.
- **`rm/css/split-view.css`** — removed `.split-pane-header`, `.split-pane-select`, `.split-pane-label`, `.split-pane-actions`, `.split-pane-btn` rules (no DOM uses them anymore). Added `.split-pane.active` with an inset 2px red `box-shadow` so the active pane's red border tracks it visually.
- **`rm/css/workflow.css`** — added split-mode pill states: `.ws-page-open` (subtle highlight + colored side dot via `::before`), `.ws-page-open--left` (green dot), `.ws-page-open--right` (blue dot), `.ws-page-active-split` (red outline + soft red glow).
- **`sw.js`** — `CACHE_VERSION` 49 → 50.

### Notes
- **No firestore.rules / functions changes.**
- **In-pane mousedown sets active.** Click anywhere in a pane (even inside the iframe) makes that pane active. Same-origin iframes don't bubble events to parent normally, but the mousedown capture-phase listener on the wrapper element catches it before the iframe takes focus.
- **Out-of-workflow split still works.** Each iframe gets its full RM nav so the user can navigate within each pane. The active-pane red border still appears (via mousedown), but the strip swap-and-close UX is workflow-only by design.
- **Hard-reload required** to evict SW cache `mcgheelab-shell-v50`.

## [V3.74] - 2026-05-06

**Non-workflow nav redesign — two options: Workflows + All Pages.** The six-group dropdown nav (Activity / Research / Operations / Lab Admin / Settings) is gone. When no workflow is active, the top nav shows just three primary buttons — `🗂 Workflows`, `⊞ All Pages`, `⊟ Split` — and the front page at `rm/index.html` has a tab toggle to flip between two views. The All Pages view is a grouped card grid where each tile shows the page label, group badge, icon, and a one-line description of what the page does.

### Changed
- **`rm/index.html`** — early head script reads `?view=all-pages|workflows` from URL and exposes `window.__RM_HOME_VIEW`. Page header gained a segmented `Workflows / All Pages` tab pill (`.rm-home-tabs`) plus the existing "Lab Overview Stats →" link. Single content container `#rm-home-root` (renamed from `#workflow-root`) is owned by whichever view is active.
- **`rm/js/workflow-chooser.js`** — boot guard short-circuits when `__RM_HOME_VIEW !== 'workflows'`. Container references switched from `#workflow-root` → `#rm-home-root`.
- **`rm/js/nav.js`** — non-workflow `renderNav()` no longer iterates `NAV_ITEMS` to build the six dropdown groups. Renders three flat top-level links: `🗂 Workflows` → `/rm/index.html`, `⊞ All Pages` → `/rm/index.html?view=all-pages`, `⊟ Split` → `/rm/pages/split-view.html`. Active state lights up based on `location.pathname` + `?view=`. The pinned `⭐ My Workflows` dropdown (V3.66) and the workflow strip (V3.64) still render unchanged.
- **`rm/css/workflow.css`** — added `.rm-home-tabs` segmented control and `.ap-grid` / `.ap-card` / `.ap-card-head` / `.ap-card-icon` / `.ap-card-titlebox` / `.ap-card-label` / `.ap-card-group` / `.ap-card-desc` / `.ap-gate-badge` for the All Pages tile grid.
- **`sw.js`** — `CACHE_VERSION` 48 → 49.

### Added
- **`rm/js/all-pages.js`** (~190 LOC) — sibling to `workflow-chooser.js`. Reads `PAGE_REGISTRY.list`, filters by `firebridge.canAccessPage`, groups by `NAV_ITEMS` section, renders ordered card sections (Dashboard / Activity / Research / Operations / Lab Admin / Settings / ⊟ Split / Other). Owns two source-of-truth maps:
  - `PAGE_DESCRIPTIONS` — one-line blurbs for each page (~40 entries covering every NAV_ITEMS page).
  - `PAGE_ICONS` — emoji icon per page id.
  - Cards with admin-gated pages get a small "admin" badge so users know they need privileges to see contents.

### Notes
- **No firestore.rules / functions changes.**
- **Direct page links in renderers** (e.g. `<a href="/rm/pages/library.html">`) all still work — only the top-nav dropdowns were dropped.
- **Adding a new RM page** now requires three things: (1) entry in `NAV_ITEMS` (nav.js), (2) blurb in `PAGE_DESCRIPTIONS` (all-pages.js), (3) optional icon in `PAGE_ICONS`. Pages without a blurb still render — the description block just collapses.
- **Hard-reload required** to evict SW cache `mcgheelab-shell-v49`.

## [V3.73] - 2026-05-06

**Workflow polish #2 — page state persistence + split-within-workflow.** Two related issues raised by the user: (a) opening a paper in the Paper Writing workflow then navigating away and clicking the Paper editor chip again returned them to the empty list instead of the paper; (b) the strip's `⊟ Split` button effectively created two unrelated workflow contexts (one per iframe + one on the parent), instead of opening a second workflow page side-by-side within the same workflow. Plan/notes inline.

### Page state persistence (chips remember where you left off)
- **`rm/js/nav.js`** — workflow state gained a `pageState: { [pageId]: '<full-url>' }` map in sessionStorage. On every strip render, nav.js identifies the chip whose pathname (and `?tab=` if applicable) matches the current URL and writes `pageState[<pageId>] = location.pathname + location.search + location.hash`. When rendering chips, each chip's `href` is the remembered URL (decorated with `?workflow=<id>`) — falling back to the canonical chip URL on first visit. Title tooltip now says "resumes where you left off" when a chip is set to a non-canonical URL.
- **Effect:** clicking the Paper editor chip while on `paper-builder.html?paper=mebp`, then jumping to Library, then clicking Paper editor again — second click goes back to `?paper=mebp`. Same applies to any page with deep state in the URL (`?tab=`, `?paper=`, `?ticket=`, `#anchor`).
- **State preserved across save-as-custom**: when the user converts a dirty default workflow into a custom one via `Save as custom`, `pageState` carries through to the new custom workflow's session.
- **State scope:** sessionStorage, so per-tab + cleared on browser quit. URL-based deep state is the persistence — re-opening the workflow tomorrow lands on the workflow's `landingPageId` (V3.66) by default.

### Split-within-workflow (single strip on parent, clean panes underneath)
- **`rm/js/nav.js`** — the strip's `⊟ Split` button now pre-fills the split URL with `left=<current page>` + `right=<next workflow page>` + `workflow=<id>` + `ratio=0.5`. Tooltip says which page will open in the right pane. Right is the *next workflow chip* after the current one (wraps to first if at end; falls back to second if next equals current). Both panes inherit the workflow context via the `?workflow=<id>` adopted by parent nav.js.
- **`rm/js/nav.js`** — `renderNav()` short-circuits when URL has `?embed=1`: skips the regular nav AND the workflow strip, and injects a small `<style>` rule hiding any `.top-nav`, `.workflow-strip`, and `#firebridge-indicator` (in case other scripts try to mount them later). Result: the parent split-view shell shows ONE workflow strip on top, and the iframes show the page content with no nested nav rows.
- **`rm/js/split-view.js`** — every iframe `src` is now passed through a new `_embedHref()` helper that appends `?embed=1` (preserving any other query params and hash). Pane dropdown swap also re-embeds.

### Files
- **Changed:** [rm/js/nav.js](../../rm/js/nav.js) — `_wfReadState` initializes `pageState`; `_wfAdoptFromUrl` + `setActive` (via the `replace_all` of `addedPageIds: [], removedPageIds: [], orderOverride: null`) initialize `pageState: {}`; chip rendering uses `state.pageState[id] || canonical_href`; `renderWorkflowStrip` saves the active chip's full URL on every render; `renderWorkflowStrip` rewrites the split link to `?workflow=<id>&left=<current>&right=<next>&ratio=0.5`; `renderNav` short-circuits on `?embed=1`; `_wfOpenSaveAsModal` carries `pageState` across the kind=default → kind=custom transition.
- **Changed:** [rm/js/split-view.js](../../rm/js/split-view.js) — `_embedHref()` helper + iframe `src` decoration; pane swap also re-embeds.
- **Changed:** [sw.js](../../sw.js) — `CACHE_VERSION` 47 → 48.

### Notes
- **No firestore.rules / functions changes.** Pure frontend.
- **Scroll position not yet preserved.** URL-level state survives chip-click round trips. In-page scroll restoration is browser-default (Chrome restores on back/forward but not on chip clicks since each chip is a fresh navigation). A V3.74 follow-up could add `beforeunload`-saved scrollY per page id.
- **Hard-reload required** to evict the SW cache (`mcgheelab-shell-v48`).

## [V3.72] - 2026-05-06

**Real fix for Email tab silently empty.** V3.70's Chart.js hoist helped but didn't root-cause the issue. The actual bug: the **Year Timeline tab block had a hardcoded `<div id="content">Loading…</div>`** baked into the static HTML. When the user was on the Email tab, `document.getElementById('content')` returned that hidden timeline `#content` (still in the DOM, just `display:none` via CSS) instead of the email tab's intended container. `renderEmails()` wrote its 250 rows into a hidden div and the user saw a blank inbox.

The inline script that's supposed to append a per-active-tab `#content` does `if (!document.getElementById('content'))` — so it skipped creating one because the timeline tab's hardcoded one already satisfied the check. Subtle.

### Changed
- **`rm/pages/activity-overview.html`** — removed the static `<div id="content">Loading…</div>` from the Year Timeline tab block. The inline script now correctly creates `#content` inside whichever tab is active (`email`, `timeline`, or `lab-stats`). Comment added pointing at the V3.72 fix for future readers.
- **`rm/js/email-review.js`** — defensively wrapped each renderer in `refresh()` in `try/catch` so a transient failure (e.g., Chart.js missing) no longer halts the whole render. **Email rows render FIRST**, before chart / activity rollup, so even if a secondary renderer throws, the inbox appears. Added a `refresh complete — rendered X of Y emails into #content` info log so the next bug is easier to localize.
- **`sw.js`** — `CACHE_VERSION` 46 → 47.

### Notes
- **No firestore.rules / functions changes.**
- **Hard-reload required** to evict the SW cache (DevTools → Application → Service Workers → "Update on reload"). Once the new HTML loads, the email tab should render the cached 250 rows immediately.
- The Year Timeline tab still works — `year-review.js` queries `#content`, which the inline script now appends dynamically in the timeline tab when `?tab=timeline` is the active URL.
- **Lessons for future tab consolidations**: when collapsing N pages into one with `?tab=` switching, every tab block must use UNIQUE element IDs OR all defer container creation to a tab-aware appender. Sharing an ID like `#content` across tabs causes silent cross-tab DOM lookups that are nearly impossible to spot in code review (the symptom is "renders into wrong tab", which only manifests at runtime when the user picks a non-default tab).

## [V3.71] - 2026-05-06

**Activity sub-nav retired.** The pill-bar at `rm/js/activity-subnav.js` (Overview / Tracker / Email / Year / Lab Stats / Explorer / Calendar / Task / Sharing / PMR / API usage) was a V3.40-era "section nav" stand-in that has been fully replaced by the V3.63–V3.66 workflow strip and the regular Activity dropdown in the top nav. Removing it eliminates the second navigation row that was still appearing on top of every Activity page even while in a workflow.

### Removed
- **`rm/js/activity-subnav.js`** — deleted (was 137 LOC).
- `<script src="/rm/js/activity-subnav.js"></script>` removed from 8 pages: [activity-overview.html](../../rm/pages/activity-overview.html), [api-usage.html](../../rm/pages/api-usage.html), [calendar.html](../../rm/pages/calendar.html), [explorer.html](../../rm/pages/explorer.html), [lab-tasks.html](../../rm/pages/lab-tasks.html), [pmr.html](../../rm/pages/pmr.html), [sharing.html](../../rm/pages/sharing.html), [tasks.html](../../rm/pages/tasks.html).

### Changed
- **`rm/js/nav.js`** — picked up the two pages whose only entry-point was activity-subnav:
  - **Activity** dropdown → added `Explorer` entry pointing at `/rm/pages/explorer.html`.
  - **Settings** dropdown → added `API Usage` entry (admin-gated) pointing at `/rm/pages/api-usage.html`.
- **`rm/pages/activity-overview.html`** — updated the V3.69 "in-page tab bar removed" comment to also note the V3.71 activity-subnav retirement.
- **`sw.js`** — `CACHE_VERSION` 45 → 46.

### Notes
- **No firestore.rules / functions changes.** Pure frontend cleanup.
- **Workflow page registry auto-updated.** `_wfBuildPageMap` in `nav.js` walks `NAV_ITEMS`, so adding Explorer + API Usage there means they're now first-class workflow-strip / admin-matrix candidates without further edits.
- **CSS for `.act-subnav`, `.act-subnav-styles`** is no longer injected — was only ever used by the deleted file.

## [V3.70] - 2026-05-06

**Bug fix — Email tab silently empty due to Chart.js loaded via document.write.** Diagnosed from user-supplied console output: a Chrome warning that the parser-blocking cross-origin `chart.js@4.4.4` script invoked via `document.write` MAY be blocked, followed by `[email-review] cache HIT for 2026 — 250 rows in 2ms (fresh)` — confirming emails were already cached but never reached the renderer. The Email tab's `refresh()` calls `renderTimeline(...)` (which does `new Chart(...)`) before `renderEmails(...)`. With Chart.js dropped/blocked, `renderTimeline` throws `Chart is not defined` and the rest of `refresh` (including `renderEmails`) never runs.

### Changed
- **`rm/pages/activity-overview.html`** — hoisted `chart.js@4.4.4` out of the per-tab `document.write` loader and into a regular `<script src=...>` tag in the body. Loads ~70 KB on every tab (including overview / lab-stats which don't use it) but eliminates the parser-blocking warning AND the silent-failure timing bomb. Tracker (was using 4.4.0 — now also 4.4.4) and Timeline tabs benefit too.
- **`sw.js`** — `CACHE_VERSION` 44 → 45.

### Notes
- **Closes problem 2 from the previous report.** Emails will render once the SW cache evicts and the new HTML loads. Hard-reload (DevTools → Application → Service Workers → Update on reload) to bypass any stuck cache.
- **No other pages affected** — calendar.html and analytics.html already loaded Chart.js via regular `<script>` tags. Only activity-overview.html had the document.write pattern.
- **GIS client** (`https://accounts.google.com/gsi/client`) is still document.write'd for the Tracker tab — it's the only consumer and loading it eagerly could cause unwanted side effects on other tabs.

## [V3.69] - 2026-05-06

**Bug fix — redundant Activity tab bar removed.** The Email tab (and every other Activity tab) had three layers of navigation: top nav + activity-subnav pill bar + an in-page tab bar with `Overview / Tracker / Year Timeline / Email / Lab Stats`. The in-page tab bar exactly mirrored the activity-subnav pill bar's Activity-area entries, just with different labels. Removed the in-page bar; activity-subnav is now the single sub-nav for Activity pages.

### Changed
- **`rm/pages/activity-overview.html`** — deleted the `#act-hub-tabs` div and the inline script that built it. Tabs are still selected via `?tab=<overview|tracker|timeline|email|lab-stats>`; the URL-driven dispatcher and per-tab `document.write` script loader are unchanged.
- **`rm/js/activity-subnav.js`** —
  - Added a `Lab Stats` pill (admin-gated via the new `gate: 'admin'` field; mirrors `nav.js`'s gating pattern).
  - Fixed active-state matching: previously compared only `currentPath`, so the `?tab=tracker` / `?tab=email` / `?tab=timeline` pills never highlighted as active. Now parses each pill's URL and compares pathname + `?tab=` independently.
  - `applyGates()` hides the Lab Stats pill for non-admin users; re-applied on `firebridge.onAuth` so role promotion picks it up.
- **`sw.js`** — `CACHE_VERSION` 43 → 44.

### Audited but unchanged
- **`rm/pages/tasks.html`** has its own `#task-hub-tabs` (Dashboard / Add Task / Task List / Completed). These are tasks-only sub-views; activity-subnav has only a single `Task` pill that points at the dashboard. The two layers serve different purposes (section vs page), so both stay.
- **`rm/pages/calendar.html`** has a `#cal-tabs` with calendar-specific sub-views (History etc.) — distinct from activity-subnav's `Calendar` pill. Kept.
- **`rm/pages/lab-tasks.html`**, **`rm/pages/library.html`**, **`rm/pages/people.html`**, **`rm/pages/settings.html`**, etc. — their tab bars are page-specific sub-views (e.g. Library Papers/Comments, People Roster/Important People). Not redundant with activity-subnav.

### Open issue (not fixed in this release)
- **Emails don't render in the Email tab.** Pre-existing data-flow issue, not a regression from V3.62–V3.68: `email-review.js` reads from `userData/{uid}/emailMessages` (populated by the Gmail scraper Cloud Function) and falls back to legacy `email_archive/summary.json` + `email_archive/by_year/<year>.json`. If the per-user collection is empty AND the legacy JSON files aren't reachable (production deploy doesn't ship the email_archive folder), the page renders empty. Need user diagnostics — browser console output + whether running locally vs production — to know which path is failing.

## [V3.68] - 2026-05-06

**Bug fix — workflow strip showed "Workflow not found / No pages" before admin seeded `labConfig/defaultWorkflows`.** When admin hadn't yet clicked "Seed defaults" on the V3.63 admin matrix, the Firestore doc didn't exist. The chooser fell back to `PAGE_REGISTRY.DEFAULT_WORKFLOWS` (loaded by `page-registry.js` on the chooser page), so the cards rendered fine. But after clicking a card and navigating to a workflow page, `nav.js`'s `_wfFetchWorkflow` had no fallback — `page-registry.js` isn't loaded on every RM page — so the strip's brand label collapsed to "Workflow not found" and the chips area showed "No pages".

### Changed
- **`rm/js/nav.js`** — inlined the 5 default-workflow seeds as `_WF_DEFAULT_SEEDS` (mirrors `page-registry.js`'s `DEFAULT_WORKFLOWS`). `_wfFetchWorkflow` for `kind === 'default'` now merges Firestore + seeds (Firestore wins on id conflicts; seeds cover any id Firestore is missing). Result: default workflows render correctly even on a fresh deploy before admin seeds the doc, and partial Firestore data still gracefully falls back to seeds for any workflow id not yet edited.
- **`sw.js`** — `CACHE_VERSION` 42 → 43.

### Notes
- **No firestore.rules / functions changes.**
- The seeds in nav.js and page-registry.js are now duplicated; comment in nav.js flags the keep-in-sync requirement. Future change: when adding a new default workflow, edit both files (or extract the seeds into a shared file loaded by both — out of scope for this fix).
- Custom workflow path unaffected — it always reads from `userData/{uid}/customWorkflows/{id}` directly.

## [V3.67] - 2026-05-06

**Bug fix — PMR missing from workflow strip chips.** Two of the V3.63 default workflows (Paper Writing, Task Scheduling & Activity Reports) reference page id `pmr`, but PMR wasn't in `NAV_ITEMS` so `_wfBuildPageMap()` couldn't resolve it — the chip was silently dropped from the workflow strip even though `rm/pages/pmr.html` exists.

### Changed
- **`rm/js/nav.js`** — added `{ label: 'PMR', href: '/rm/pages/pmr.html' }` to the Activity group's children, between Year and Calendar (matches the order used by `activity-subnav.js`). Now the Paper Writing and Task Scheduling workflow strips render the PMR chip, and PMR is also reachable from the regular Activity dropdown.
- **`sw.js`** — `CACHE_VERSION` 41 → 42.

### Notes
- **No firestore.rules / functions changes.**
- **The two future placeholders** (`lab-notebook`, `protocols`) referenced by Lab Research + Paper Writing workflow seeds are intentional — they'll surface as chips automatically when those pages ship.
- Audited the remaining default-workflow pageIds; PMR was the only resolvable page missing from `NAV_ITEMS`.

## [V3.66] - 2026-05-06

**Workflow polish — drag-to-reorder, pinned custom workflows, per-workflow landing page.** Three quality-of-life additions to the V3.63–V3.65 workflow feature. Plan doc: [CodeLog/ClaudesPlan/V3.66_workflow_polish.md](../ClaudesPlan/V3.66_workflow_polish.md).

### Drag-to-reorder strip chips
- Each `.ws-page` chip is now `draggable=true`. HTML5 dragstart/dragover/drop reorders chips in place; the new order persists to sessionStorage as `state.orderOverride: [...]` and is rendered immediately. The × button is excluded from drag (its mousedown stops propagation; a dragstart preventDefault keeps it inert).
- `_wfEffectivePageIds` honors `orderOverride` when present — first emits ids from the override that still exist in source, then appends any added/base ids not yet in the override (so reorder doesn't hide subsequent additions).
- Visual states: `.ws-page-dragging` (the dragged chip; opacity .4) and `.ws-page-drop-before` / `.ws-page-drop-after` (amber inset shadow on the target chip indicating insertion side).
- "Save changes" / "Save as custom" treats reorder as a dirty edit — saving folds `orderOverride` into `pageIds` and clears the override.

### Pinned custom workflows in the regular nav
- After the six-group nav renders (only when no workflow is active), `_wfPinCustomWorkflows()` fetches `userData/{uid}/customWorkflows` and appends a `⭐ My Workflows ▾` dropdown. Each entry is one custom workflow; clicking enters the workflow at its `landingPageId` (or first accessible page).
- Result is cached in `_wfCustomCache` for the page lifetime so re-renders (e.g. on auth state change) don't re-query.
- Includes a `Manage workflows…` italic link at the bottom of the menu pointing back at the chooser.
- `workflow.css` is injected dynamically by nav.js when the dropdown renders so the regular nav isn't forced to load it eagerly.

### Per-workflow default landing page
- New `landingPageId` field on every workflow record (default workflow seed in `page-registry.js`, `labConfig/defaultWorkflows` doc, `userData/{uid}/customWorkflows/*`).
- Chooser cards (default + custom) navigate to `landingPageId` if set + accessible; else the first accessible page.
- Admin matrix `/rm/pages/admin-permissions.html?tab=workflows` row labels grew a `Landing` dropdown that shows the workflow's currently-checked pages and writes to the doc on Save. Auto-refreshes when checkboxes toggle (so removing the landing page from the workflow drops it from the dropdown).
- Custom workflow builder modal grew a `Landing page` dropdown below the page picker. Defaults to "First selected page". Updates live as the user toggles page checkboxes.
- "Save as custom" (strip → modal) inherits the source workflow's `landingPageId` when it's still in the effective page list; otherwise empty (first page).
- Pinned-nav dropdown entries point at `landingPageId` per workflow.

### Files
- **Changed:** [rm/js/nav.js](../../rm/js/nav.js) — drag handlers (`_wfChipDragStart`, `_wfChipDragEnd`, `_wfChipDragOver`, `_wfChipDragLeave`, `_wfChipDrop`), pinned-nav (`_wfPinCustomWorkflows`), `_wfEffectivePageIds` honors `orderOverride`, `_wfReadState` + `_wfAdoptFromUrl` + `setActive` initialize `orderOverride: null`, save flow inherits `landingPageId` and clears override after save.
- **Changed:** [rm/js/page-registry.js](../../rm/js/page-registry.js) — added `landingPageId` to each of the 5 default workflow seeds (Lab Research → tracker, Paper Writing → paper-builder, Cert → compliance, Task Scheduling → tasks, Meetings → meetings).
- **Changed:** [rm/js/workflow-state.js](../../rm/js/workflow-state.js) — `setActive` initializes `orderOverride: null`.
- **Changed:** [rm/js/workflow-chooser.js](../../rm/js/workflow-chooser.js) — `pickLandingPage()` helper; both card click handlers use it; builder modal grew a `Landing page` dropdown auto-populated from picked pages.
- **Changed:** [rm/js/admin-permissions.js](../../rm/js/admin-permissions.js) — workflows tab row labels grew a `Landing` select; `onWorkflowLandingChange` tracks pending edits with `type: 'workflow-landing'`; save flushes `landingPageId` per workflow; seed migration includes `landingPageId`.
- **Changed:** [rm/css/workflow.css](../../rm/css/workflow.css) — `.ws-page-dragging`, `.ws-page-drop-before`, `.ws-page-drop-after`, `.nav-dropdown-pinned`, `.dropdown-divider`.
- **Changed:** [sw.js](../../sw.js) — `CACHE_VERSION` 40 → 41.

### Notes
- **No firestore.rules changes.** The `landingPageId` field rides on the existing `labConfig/defaultWorkflows` and `userData/{uid}/customWorkflows/*` writes; existing rules cover both.
- **No functions deploy.**
- **Pinned-nav dropdown is empty for users with no custom workflows** — the dropdown isn't rendered at all in that case, so no UI clutter.
- **Drag-and-drop falls back gracefully on touch devices** that don't fire dragstart; chip reorder via × + Add is still available.

## [V3.65] - 2026-05-06

**Workflow-driven UX redesign · PR 3 — custom workflows + builder.** Wires up the V3.64 placeholder buttons in the workflow strip and adds the My Workflows section + builder UI on the chooser. Closes the three-PR workflow redesign initiative. Plan doc: [CodeLog/ClaudesPlan/V3.65_workflow_custom.md](../ClaudesPlan/V3.65_workflow_custom.md).

### Workflow strip becomes interactive
- **Page chip × button** (each chip on the strip now has a small × on hover-reachable affordance) → marks the page as `removedPageIds` in sessionStorage; strip re-renders without the chip. Removing a previously-added page un-adds instead of negative-removing.
- **+ Add page** — opens a modal listing accessible pages NOT already in the workflow, grouped by section, with a search filter. Click a row → adds page to sessionStorage's `addedPageIds` (un-removes if previously removed); strip re-renders.
- **Save as custom** (visible when `addedPageIds.length || removedPageIds.length` for a default workflow) — opens a name modal with `<workflow label> (mine)` pre-filled. Slugifies the name to a kebab-case id; writes a new doc at `userData/{uid}/customWorkflows/{slug}` with `{ id, label, description, icon: '⭐', pageIds, basedOn, createdAt, updatedAt }`. After save, switches the active state to the new custom id (kind='custom') so the strip continues to operate on the saved workflow.
- **Save changes** (visible on custom workflows when dirty) — direct save back to the custom doc; clears `addedPageIds`/`removedPageIds`.

### Workflow chooser ships the My Workflows section
- **My workflows** section on `rm/index.html` lists `userData/{uid}/customWorkflows/*`. Each card has Rename + Delete buttons (header-row affordances; click body to enter the workflow).
- **+ New custom workflow** card opens the builder modal: name input + multi-select page picker (grouped, with filter). Pages filtered by `firebridge.canAccessPage`. Picking ≥1 page + a name → creates the doc and re-renders the chooser.
- **Rename**: simple `prompt()` for now; updates the doc's `label`. Slug stays the same.
- **Delete**: confirm dialog → `db().delete()` → re-render.

### Files
- **Changed:** [rm/js/nav.js](../../rm/js/nav.js) — added `_wfWriteState`, `_wfRemovePage`, `_wfAddPage`, `_wfRefreshStrip`, `_wfOpenAddPageModal`, `_wfSaveCurrent`, `_wfOpenSaveAsModal`. The strip's "+ Add page", chip × buttons, and "Save as custom" / "Save changes" buttons are now functional. ~210 LOC of new strip-mutation code.
- **Changed:** [rm/js/workflow-chooser.js](../../rm/js/workflow-chooser.js) — `renderCustomCard()`, `renderNewCustomCard()`, `openBuilder()`, `renameCustom()`, `deleteCustom()`. The chooser now renders both default + custom workflow grids and surfaces the builder.
- **Changed:** [rm/css/workflow.css](../../rm/css/workflow.css) — `.wf-card-actions`, `.wf-custom-card` (left-border accent), `.wf-new-card` (dashed border, primary-tinted icon).
- **`sw.js`** — `CACHE_VERSION` 39 → 40.

### Notes
- **No firestore.rules changes.** `userData/{uid}/customWorkflows/*` reads/writes are covered by the existing `userData/{uid}/{document=**}` owner-only rule (firestore.rules:735). No new functions deploy.
- **Renaming is via `prompt()`** — quick path. A nicer modal could ship in V3.66 if needed.
- **Builder picks pages preserving insertion order** (Set is insertion-ordered in JS) so the workflow strip displays them in the order the user picked.

### Cumulative across V3.63–V3.65
- New Firestore paths: `labConfig/defaultWorkflows`, `userPermissions/{uid}`, `userData/{uid}/customWorkflows/*`.
- New rules block: `userPermissions/{userId}` (admin-write, owner+admin read).
- New helpers: `firebridge.canAccessPage`, `firebridge.loadAccessGrant`.
- New pages: `rm/pages/admin-permissions.html` (admin matrix), `rm/pages/lab-overview.html` (preserved V3.62 stats).
- Front page rewritten: `rm/index.html` is now the workflow chooser; the V3.62 stats grid moved to `lab-overview.html`.
- `rm/js/nav.js`: 230 → ~640 LOC. Workflow-strip fork inlined so every page that loads nav.js gets the strip.
- 5 default workflows seeded; users can create unlimited custom workflows under their account.

## [V3.64] - 2026-05-06

**Workflow-driven UX redesign · PR 2 — workflow chooser + workflow-aware nav strip.** Building on V3.63's foundation, the front page becomes a workflow chooser and every RM page learns to render a focused page strip when a workflow is active. The six-group dropdown nav stays as the "no active workflow" default. Plan doc: [CodeLog/ClaudesPlan/V3.64_workflow_shell.md](../ClaudesPlan/V3.64_workflow_shell.md).

### Added
- **`rm/index.html`** rewrite — **workflow chooser** replaces the V3.62 14-card stats grid. Top-right "Lab Overview Stats →" link preserves the cards at a new home.
- **`rm/pages/lab-overview.html`** — new home for the V3.62 dashboard cards (renderer `dashboard.js` unchanged). Reachable from the workflow chooser top-right link.
- **`rm/js/workflow-chooser.js`** (~140 LOC) — renders the workflow chooser UI: grid of cards, one per workflow. Each card shows icon, label, page count, description, and the first 6 page chips. Click → `WorkflowState.setActive()` + navigate to first accessible page (with `?workflow=<id>` query so the workflow context is bookmarkable on entry). Workflows with zero accessible pages are filtered out (per V3.63 access rules). Renders an empty "My workflows" hook for V3.65 custom workflows.
- **`rm/js/workflow-state.js`** (~210 LOC) — sessionStorage helpers. `read()`, `write()`, `clear()`, `adoptFromUrl()` (one-time URL → state migration with history.replaceState scrub), `effectivePageIds()`, `isDirty()`, `addPage()`, `removePage()`, `loadActive()`, `loadDefaultWorkflows()`, `loadCustomWorkflows()`, `setActive()`, `decorateHref()`. Exported as `window.WorkflowState`. Used by the chooser (and the V3.65 builder) — NOT loaded on every RM page (see nav.js note).
- **`rm/css/workflow.css`** (~140 LOC) — shared styles for chooser cards (`.wf-*`) and the workflow strip (`.workflow-strip`, `.ws-*`) plus the V3.65 add-page modal (`.ws-modal-*`). Loaded eagerly on rm/index.html; injected dynamically by nav.js whenever the strip renders so other pages don't pay the cost when no workflow is active.

### Changed
- **`rm/js/nav.js`** — workflow-strip fork. `renderNav()` now reads sessionStorage early via inlined helpers (`_wfReadState`, `_wfAdoptFromUrl`, `_wfPageIdFromHref`, `_wfBuildPageMap`, `_wfFetchWorkflow`, `_wfEffectivePageIds`, `_wfDecorateHref`) and renders `renderWorkflowStrip()` instead of the six-group nav whenever a workflow is active. The strip awaits `firebridge.whenAuthResolved()` + `firebridge.loadAccessGrant()` so `canAccessPage` filters correctly before chips render. The strip's read logic is kept inline in nav.js (rather than depending on `workflow-state.js` + `page-registry.js`) so every RM page that loads nav.js gets the strip without per-page script changes. Strip rendering: brand link → chooser, page chips (active highlight on current path), `+ Add page` (disabled with V3.65 placeholder tooltip), `⊟ Split` (decorated with `?workflow=`), `Save as custom` (only when dirty; V3.65 placeholder), `× Leave workflow` (clears state + reloads).
- **`sw.js`** — `CACHE_VERSION` 38 → 39.

### Notes
- **No firestore.rules / functions changes.** Pure frontend. The workflow strip's Firestore reads (`labConfig/defaultWorkflows`, `userData/{uid}/customWorkflows/{id}`) are gated by V3.63's existing rules.
- **`rm/index.html` is now a workflow chooser, not a stats dashboard.** Anyone landing on `/rm/` sees the workflow grid. The 14-card summary view is preserved at `/rm/pages/lab-overview.html` and reachable from the chooser's top-right link.
- **Nav behavior on every page**: when sessionStorage has an active workflow, the workflow strip renders instead of the six-group dropdown nav. The strip is generic — works on every existing RM page without per-page changes. `× Leave workflow` clears sessionStorage + reloads → six-group nav returns. nav.js workflow logic is read-only; mutations (setActive / addPage / save-as-custom) happen on the chooser + (V3.65) builder pages.
- **`?workflow=<id>` URL param** is recognized as a one-time entry signal — adopted into sessionStorage, then stripped from the URL via `history.replaceState`. This means external bookmarks like `…/library.html?workflow=paper-writing` enter the workflow context cleanly.
- **`+ Add page` and `Save as custom`** buttons are present in the strip but disabled with tooltip placeholders. V3.65 wires them up.
- **Net page count:** 39 → 40 (lab-overview.html added).

## [V3.63] - 2026-05-06

**Workflow-driven UX redesign · PR 1 — foundation.** Sets up the Firestore data model + admin tooling for the new workflow feature without changing what any non-admin user sees yet. PRs 2 (V3.64) and 3 (V3.65) layer on the workflow chooser dashboard, the workflow-aware nav strip, and per-user custom workflows. Plan doc: [CodeLog/ClaudesPlan/V3.63_workflow_foundation.md](../ClaudesPlan/V3.63_workflow_foundation.md).

### Added
- **`rm/js/page-registry.js`** (~155 LOC) — flattens `nav.js`'s `NAV_ITEMS` into a stable list of page entries (`{ id, label, href, group, gate }`). Page ids are derived from URL+`?tab=` (e.g. `library`, `library__tab__comments`, `activity-overview__tab__tracker`) so any page added to the nav becomes pickable in the admin matrix without a code path on the new feature side. Exports `window.PAGE_REGISTRY = { list, byId, byHref, pageIdFromHref, DEFAULT_WORKFLOWS, defaultPageIdSet }`. Five default workflows (Lab Research / Paper Writing / Certification & Training / Task Scheduling & Activity Reports / Meetings) are seeded as constants — the admin matrix can override these in Firestore but the constants are the fallback when the doc doesn't exist yet.
- **`rm/pages/admin-permissions.html`** + **`rm/js/admin-permissions.js`** (~370 LOC) — admin-gated two-tab matrix page. Reused `.mig-table` styling extended with sticky-row + sticky-column for matrix scrolling.
  - **Users × Pages tab** (default) — rows = `users/*` profiles (excluding admins), columns = every PAGE_REGISTRY page grouped by section. Checkbox toggle writes to `userPermissions/{uid}.allowedPageIds`. Save button batches all changes; setting an empty list deletes the doc (so the user falls back to implicit baseline access).
  - **Default Workflows × Pages tab** — rows = the 5 default workflows (read from `labConfig/defaultWorkflows` if present, else seeded from PAGE_REGISTRY constants). Columns = PAGE_REGISTRY. Save writes the whole `{ workflows: [...] }` doc.
  - First-run "Seed defaults" button writes the PAGE_REGISTRY seed to Firestore when the labConfig/defaultWorkflows doc doesn't exist.
  - Page reused the V3.62 `?tab=` URL pattern for tab switching; admin gate uses `firebridge.gateAdmin('manage workflow permissions')`.

### Changed
- **`rm/js/firebase-bridge.js`** — added `canAccessPage(pageId)` + `loadAccessGrant()`. `canAccessPage` is the synchronous gate used by the workflow chooser (PR 2) and custom-workflow builder (PR 3): admin always wins; otherwise checks `userPermissions/{uid}.allowedPageIds` (or falls back to the union of pages across all default workflows when no grant doc exists). `loadAccessGrant()` lazily fetches the grant doc once per page and is awaited during boot.
- **`rm/js/api-routes.js`** — added two routes:
  - `workflows/defaults.json` → `labConfig/defaultWorkflows` (lab-scope, LONG cache, no shadow JSON; admin-write guarded by existing `labConfig/{docId}` rule at firestore.rules:464).
  - `workflows/custom.json` → `userData/{uid}/customWorkflows` (user-scope, SHORT cache; owner-write covered by existing `userData/{uid}/**` rule). The per-user page-access grant is intentionally NOT registered as an `api.*` route — it's stored at top-level `userPermissions/{uid}` and read/written via direct `firebridge.db()` calls from `admin-permissions.js` and the new `loadAccessGrant()` helper.
- **`firestore.rules`** — new rule block for `userPermissions/{userId}` collection: owner+admin read, admin-only write. Stored as a top-level collection (not a field on `users/{uid}`) because the existing `users/{uid}` write rule lets the owner write any field of their own profile, which would let users grant themselves any page.
- **`rm/js/nav.js`** — added `Settings → Permissions` admin-gated entry pointing at the new admin matrix page.
- **`sw.js`** — `CACHE_VERSION` 37 → 38.

### Notes
- **Requires `firebase deploy --only firestore:rules`** at merge — the new `userPermissions/{userId}` rule needs to be live before admin-permissions.js can write.
- **Site behavior is unchanged for non-admin users.** The data model + admin tooling ship now; the workflow chooser + workflow-aware nav strip + custom-workflow persistence land in V3.64 + V3.65.
- **Net page count:** 38 → 39 (admin-permissions.html added). Visible only to admins.
- **No functions deploy** required.

## [V3.62] - 2026-05-05

**Page consolidation Tier 4 — activity hub.** The five activity-related pages (activity-overview / activity-tracker / year-review / email-review / activity-summary) collapse into one tab-aware shell at [rm/pages/activity-overview.html](../../rm/pages/activity-overview.html) selected by `?tab=<overview|tracker|timeline|email|lab-stats>`. This is the largest single page-merge in the V3.57–V3.62 sweep and closes the consolidation work for this session. Plan doc: [CodeLog/ClaudesPlan/V3.62_page_consolidation_tier4.md](../ClaudesPlan/V3.62_page_consolidation_tier4.md).

### Added
- **`rm/css/activity-overview.css`** (489 LOC) — extracted from former inline `<style>` block in activity-overview.html. Holds the `act-*` action bar, `jp-*` job progress, `act-stats` / `act-tile` cards, `cx-*` Category Explorer, and `act-recent-*` feed styles.
- **`rm/css/year-review.css`** (96 LOC) — extracted from former year-review.html. `yr-*` toolbar / category section / line / detail / actionbar.
- **`rm/css/email-review.css`** (85 LOC) — extracted from former email-review.html. `ch-*` toolbar / summary / analytics, `er-*` tags, `cat-toggle-*`, `disp-*` chips, `em-bulk-bar` selectors.

### Changed
- **`rm/pages/activity-overview.html`** — rewritten as the unified Activity hub. Reads `?tab=` early and exposes `window.__ACT_TAB` + `<html data-act-tab>`. Five tab-bar links (Overview / Tracker / Year Timeline / Email / Lab Stats). Each tab's DOM block is wrapped in `.act-tab.tab-<name>`; CSS rules `html[data-act-tab="<X>"] .act-tab:not(.tab-<X>) { display: none; }` hide inactive blocks before first paint. The four extracted CSS files load eagerly (each scoped to its prefix; harmless cross-tab). The trailing inline body script uses `document.write` to inject only the active tab's renderer scripts: overview → `yr-shared` + `task-editor` + `explorer-detail` + `activity-overview.js`; tracker → `chart.js@4.4.0` + `rm-categories` + GIS client + `calendar-service` + `activity-tracker.js`; timeline → `yr-shared` + `chart.js@4.4.4` + `cv-schemas` + `cv-send` + `year-review.js`; email → `yr-shared` + `disp-shared` + `task-editor` + `chart.js@4.4.4` + `task-quick-builder` + `email-review.js`; lab-stats → `activity-summary.js`. A separate inline script appends a single `#content` div to the active tab's block when needed (timeline / email / lab-stats renderers all query `#content` — only one is active at a time).
- **`rm/pages/activity-tracker.html`**, **`rm/pages/year-review.html`**, **`rm/pages/email-review.html`**, **`rm/pages/activity-summary.html`** — replaced with `<meta refresh>` redirects to `activity-overview.html?tab=<name>`. Bookmarks survive.
- **`rm/js/nav.js`** — Activity dropdown rebuilt: Overview / Tracker / Email / Year now point at the unified hub via `?tab=`; Calendar / Tasks / Sharing kept as they were (separate pages). Settings group: "Member Activity" admin link repointed to `activity-overview.html?tab=lab-stats`.
- **`rm/js/dashboard.js`** — three card hrefs repointed: "Email" / "Email Archive" → `activity-overview.html?tab=email`; "Year in Review" → `?tab=timeline`; "Member Activity" → `?tab=lab-stats`. Bypasses the redirect bounce.
- **`rm/js/activity-subnav.js`** — subnav pill list rebuilt: Overview / Tracker / Email / Year now point at the unified hub via `?tab=`. Calendar / Task / Sharing / PMR / API usage / Explorer keep their separate-page URLs. (The legacy `ACTIVITY_EXTRA_PATHS` and `TASK_PATHS` from V3.58 stay — they reference now-redirecting pages, harmless.)
- **`sw.js`** — `CACHE_VERSION` 36 → 37.

### Notes
- **No firestore.rules / functions changes.** All four migrated renderers + the existing activity-overview renderer keep their existing Firestore reads / writes unchanged. Pure shell unification.
- **Renderer scripts unchanged.** `activity-tracker.js` (2123 LOC), `year-review.js` (1507 LOC), `email-review.js` (2254 LOC), `activity-summary.js` (172 LOC), `activity-overview.js` (4309 LOC) — none modified. Each one's `DOMContentLoaded` boot fires at the natural time and finds its expected DOM.
- **Tab switch is still a full page reload** (URL changes, page reloads, only the active tab's renderer boots). With SW caching this is fast (~150ms cached). Future enhancement could refactor to a true SPA tab swap if reload cost becomes annoying.
- **`rm/pages/calendar.html` and `rm/pages/sharing.html` stay separate** — calendar has operational tools (Outlook sync, Booked Time, Availability) beyond review; sharing is task collaboration, distinct domain. Per the consolidation plan.
- **Net page reduction:** 42 → 38 user-facing pages (-4 in this PR).

### Cumulative impact since V3.57
- **51 → 38 user-facing pages** (-13). Primary navigation surface ~25% smaller.
- **No firestore.rules / indexes / functions deploys** required across the entire V3.57–V3.62 sweep. Pure frontend reorganization.
- All renderer scripts kept their existing structure — the merge is purely shell-level. Per-tab document.write loading means inactive tabs never boot or query Firestore.
- Bookmarks for every old URL survive via `<meta refresh>` (or, for paper-editor, a JS redirect that preserves the id query param).

## [V3.61] - 2026-05-05

**Page consolidation Tier 3c+3d — cv-overview + important-people merges.** Two more separate pages collapse into tabs of their primary sibling: cv-overview becomes `cv-editor.html?tab=lab`, important-people becomes `people.html?tab=important`. Both old pages are now `<meta refresh>` redirects. Plan doc: [CodeLog/ClaudesPlan/V3.61_page_consolidation_tier3cd.md](../ClaudesPlan/V3.61_page_consolidation_tier3cd.md).

### Changed
- **`rm/pages/cv-editor.html`** — rewritten as unified shell with tabs `My CV` (default) / `Lab Overview`. Reads `?tab=` early; sets `<html data-cv-tab>` for CSS visibility. Two DOM blocks (`.cv-mine-block` + `.cv-lab-block`) coexist; CSS hides the inactive one. The cve-* modal lives inside `.cv-mine-block` so it hides automatically on the lab tab. Per-tab scripts via document.write: mine → `cv-importers.js` + `cv-export.js` + `cv-editor.js`; lab → `cv-overview.js`. Common scripts (firebase, firebridge, `cv-schemas.js`) load eagerly.
- **`rm/pages/cv-overview.html`** → `<meta refresh>` to `cv-editor.html?tab=lab`. Bookmarks survive.
- **`rm/pages/people.html`** — rewritten as unified shell with tabs `Lab Roster` (default) / `Important People`. Reads `?tab=` early; sets `<html data-people-tab>` for CSS visibility. Two page-header variants coexist (`.people-roster-header` + `.people-important-header`); the inner containers `#tabs` + `#content` + `#context-area` + `#filters` are shared since only one renderer loads per page hit. The `.dossier-*` / `.convo-*` / `.relevance-badge` / `.context-banner` / `.filter-*` styles from former important-people.html are inlined into the unified shell's `<style>` (~80 LOC; harmless on the roster tab). Per-tab renderer via document.write: roster → `people.js`; important → `important-people.js`. Common scripts (firebase, firebridge, `forms.js`) load eagerly.
- **`rm/pages/important-people.html`** → `<meta refresh>` to `people.html?tab=important`.
- **`rm/js/nav.js`** — Settings group: "CV Editor" + "CV Overview" entries reordered (Editor first, then Overview-as-tab); Lab Admin group: "Important People" link repointed to `people.html?tab=important`.
- **`rm/js/dashboard.js:406`** — CV Status card link repointed to `cv-editor.html?tab=lab`.
- **`sw.js`** — `CACHE_VERSION` 35 → 36.

### Notes
- **No firestore.rules / functions changes.** Both `cvData/{uid}` (CV) and `people/*.json` + `important-people/*.json` Firestore reads are unchanged. Pure shell unification.
- **All four renderers (`cv-editor.js`, `cv-overview.js`, `people.js`, `important-people.js`) are unchanged.** With document.write loading only the active tab's renderer, the inactive one never boots and never queries Firestore.
- **`career.html`** stays separate per the plan — PI tenure dossier is distinct PI-only data, not part of the People hub.
- **Net page reduction:** 44 → 42 user-facing pages (-2 in this PR).

## [V3.60] - 2026-05-05

**Page consolidation Tier 3b — paper-builder + paper-editor merge.** The Papers list and the per-paper Yjs editor merge into a single page selected by the presence of `?paper=<id>` on `paper-builder.html`. Both DOM blocks coexist; CSS hides the inactive one; only the active mode's renderer scripts load. Plan doc: [CodeLog/ClaudesPlan/V3.60_page_consolidation_tier3b.md](../ClaudesPlan/V3.60_page_consolidation_tier3b.md).

### Changed
- **`rm/pages/paper-builder.html`** — rewritten as unified shell. Early head script reads `?paper=` and sets `window.__PAPER_MODE` (`'editor'` if present, `'list'` otherwise) + `<html data-paper-mode>`. Both DOM blocks (`.paper-list-mode` and `.paper-editor-mode`) are present; CSS rule `html[data-paper-mode="editor"] .paper-list-mode { display: none; }` (and inverse) hides the inactive block before first paint. KaTeX stylesheet is loaded eagerly (CSS only — no JS cost on the list mode). The trailing inline body script uses `document.write` to load the per-mode script set: list → `paper-builder.js`; editor → `paper-yjs.js` + `paper-blocks.js` + `paper-export-tex.js` + `paper-editor.js`. Common scripts (firebase, firebridge, `paper-schemas.js`) load eagerly for both modes.
- **`rm/pages/paper-editor.html`** — replaced with a JS redirect that preserves the paper id query param across the URL change (`?id=<x>` → `?paper=<x>`). A simple `<meta refresh>` would have lost the param.
- **`rm/js/paper-editor.js:23`** — paper-id reader updated to accept `?paper=` (new) or `?id=` (legacy bookmark survival): `_qp.get('paper') || _qp.get('id') || ''`.
- **`rm/js/paper-builder.js:63,184`** — the list card link and the post-create navigation both now point at `paper-builder.html?paper=<id>` instead of the old `paper-editor.html?id=<id>`. Header doc-comment updated.
- **`sw.js`** — `CACHE_VERSION` 34 → 35.

### Notes
- **No firestore.rules / functions changes.** Yjs draft storage at `papers/{paperId}/draft` and the comments subcollection are unchanged. Pure shell unification.
- **Renderer scripts `paper-builder.js` (209 LOC) and `paper-editor.js` (2181 LOC) keep their existing structure** — each one's `DOMContentLoaded` boot still fires at the natural time and finds its expected DOM elements. With document.write loading only the active mode's scripts, only one renderer boots per page hit.
- **Net page reduction:** 45 → 44 user-facing pages.

## [V3.59] - 2026-05-05

**Page consolidation Tier 3a — library-comments → library tab.** Cross-paper Annotations feed merges into [rm/pages/library.html](../../rm/pages/library.html) as `?tab=comments`. Both DOM blocks now coexist on the page; CSS hides the inactive one; only the active tab's renderer scripts load via `document.write`. Plan doc: [CodeLog/ClaudesPlan/V3.59_page_consolidation_tier3a.md](../ClaudesPlan/V3.59_page_consolidation_tier3a.md).

### Changed
- **`rm/pages/library.html`** — early `<script>` reads `?tab=` and exposes `window.__LIB_TAB` + sets `<html data-lib-tab>` for CSS visibility toggling. Title becomes "Comments & Annotations — McGhee Lab" when tab=comments. Two tab-bar links (`Papers` / `Comments`) added under the page heading. The `.lc-*` styles from the former library-comments.html are inlined into the unified shell's `<style>` block (~60 LOC; scoped to `.lc-*`, harmless on the papers tab). The papers DOM (extension-install card, dropzone, toolbar, customize modal, table) wraps in `.lib-papers-block`; the comments DOM (toolbar, multiselects, rows container) wraps in `.lib-comments-block`. CSS rules `html[data-lib-tab="comments"] .lib-papers-block { display: none; }` (and the inverse) hide the inactive block. A trailing inline body script uses `document.write` to load the per-tab renderer set: papers → `firebase-storage-compat` + `library-upload.js` + `library-metadata.js` + `library-sync.js` + `library-prefs.js` + `task-assign.js` + `library.js`; comments → `annotation-sync.js` + `annotation-groups.js` + `library-comments.js`. Common scripts (firebase auth/firestore + firebridge + library-tags) load eagerly for both tabs.
- **`rm/pages/library-comments.html`** — replaced with `<meta refresh>` redirect to `library.html?tab=comments`.
- **`rm/js/nav.js`** — Comments entry under Research group repointed from `library-comments.html` to `library.html?tab=comments`.
- **`sw.js`** — `CACHE_VERSION` 33 → 34.

### Notes
- **No firestore.rules / functions changes.** Pure shell unification; both renderers (`library.js` + `library-comments.js`) keep their existing Firestore reads.
- **Renderer scripts unchanged.** Each one's `boot()` still queries its own DOM IDs (`#library-tbody` for papers, `#lc-rows` for comments). With `document.write` injecting only the active tab's scripts, the inactive renderer never boots and never queries Firestore.
- **Net page reduction:** 46 → 45 user-facing pages.

## [V3.58] - 2026-05-05

**Page consolidation Tier 2 — tasks subpages → tabs.** The four-page Task hub (tasks.html / tasks-add.html / tasks-inbox.html / tasks-archive.html) collapses to a single tab-aware shell at [rm/pages/tasks.html](../../rm/pages/tasks.html) selected via `?tab=<dashboard|add|inbox|archive>`. The other three pages now `<meta refresh>` to the new tab URL so existing bookmarks survive. Plan doc: [CodeLog/ClaudesPlan/V3.58_page_consolidation_tier2.md](../ClaudesPlan/V3.58_page_consolidation_tier2.md).

### Changed
- **`rm/pages/tasks.html`** — rewritten as a unified shell. Reads `?tab=<name>` early and exposes it on `window.__TASKS_TAB`; the tab bar renders four hash-style links pointing back at `tasks.html?tab=...`; an inline body script swaps in the right page-header markup + the right container div (`#dash-content` for dashboard/add, `#content` for inbox/archive) and uses `document.write` to synchronously inject the per-tab renderer script (the simplest way to load a parser-blocking `<script>` with a dynamic src so the renderer's `DOMContentLoaded` boot fires at the natural time). The four common renderer scripts are loaded eagerly (`tasks-dashboard-buckets.js` / `tasks-inbox-buckets.js` / `tasks-archive-buckets.js` / `tasks-buckets.js` — only the active tab's script is loaded).
- **`rm/pages/tasks-add.html`**, **`rm/pages/tasks-inbox.html`**, **`rm/pages/tasks-archive.html`** — replaced with `<meta refresh>` redirects to `tasks.html?tab=add|inbox|archive`. Bookmarks survive.
- **`rm/js/tasks-dashboard-buckets.js`** — three "Add Task" link sites (line 329 adder header, line 479 "View all proposed", line 1130 row-level deep link) updated to `tasks.html?tab=add[#<subtask-id>]`. The line-1130 deep link previously pointed at the malformed `/pages/tasks-add.html` (missing `/rm/` prefix). Header doc-comment updated.
- **`rm/js/tasks-inbox-buckets.js`** — two "Open in adder" link sites (line 272 header, line 475 row-level) updated to `tasks.html?tab=add`. Header doc-comment updated.
- **`rm/js/pmr.js:995`** — "→ tasks" deep-link from PMR weekly entry rows now points at `tasks.html?tab=add`.
- **`rm/js/activity-overview.js:301`** — "Task Inbox" tile updated to `tasks.html?tab=inbox`.
- **`sw.js`** — `CACHE_VERSION` bumped 32 → 33.

### Notes
- **No firestore.rules / functions changes.** Pure frontend reorganization. The four renderers (`tasks-dashboard-buckets.js` / `tasks-inbox-buckets.js` / `tasks-archive-buckets.js` / `tasks-buckets.js`) are unchanged — they still each look for their own container element (`#dash-content` or `#content`) and boot on `DOMContentLoaded`.
- **`rm/js/activity-subnav.js`** left untouched — its `ACTIVITY_EXTRA_PATHS` (lines 24-28) and `TASK_PATHS` (lines 47-52) still list the legacy `/tasks-add.html` / `/tasks-inbox.html` / `/tasks-archive.html` paths, but with redirects in place those URLs immediately bounce to `tasks.html?tab=...` so the subnav's "Task" pill highlights correctly via the existing `currentPath === '/rm/pages/tasks.html'` match. No correctness issue.
- **`rm/pages/lab-tasks.html`** unchanged — its own internal tab bar still links to the legacy URLs, which redirect cleanly.
- **Net page reduction:** 49 → 46 user-facing pages.

## [V3.57] - 2026-05-05

**Page consolidation Tier 1 — orphan deletions.** First in a 4-tier sweep (V3.57–V3.62) reducing the RM page count from 51 → 38. This release deletes two pages whose renderers were already orphaned or superseded. No user-visible feature loss. Plan doc: [CodeLog/ClaudesPlan/V3.57_page_consolidation_tier1.md](../ClaudesPlan/V3.57_page_consolidation_tier1.md).

### Removed
- **`rm/js/funding.js`** (269 LOC) — orphan since `rm/pages/funding.html` was made a `<meta refresh>` redirect to grants.html. The data routes (`funding/proposals.json`, `funding/awards.json`, `funding/accounts.json`) stay registered in [api-routes.js](../../rm/js/api-routes.js) — they're still consumed by [grants.js](../../rm/js/grants.js) and [dashboard.js](../../rm/js/dashboard.js). This removal is purely the unused renderer.
- **`rm/js/purchase-requests.js`** (256 LOC) — superseded by V3.44's procurement.js (844 LOC) which provides the full request → approve → order → receive → place lifecycle. Wrote against legacy `purchaseRequests` Firestore collection; procurement.js writes to `procurementTickets`.

### Changed
- **`rm/pages/purchase-requests.html`** — replaced with a `<meta refresh>` redirect to `/rm/pages/procurement.html` so old bookmarks survive.
- **`rm/pages/funding.html`** — fixed the redirect URL from `/pages/grants.html` (broken — missing `/rm/` prefix) to `/rm/pages/grants.html`. Drive-by fix.
- **`rm/js/nav.js`** — removed the "Purchase Requests" entry from the Lab Admin group. Procurement is the single entry point now.
- **`sw.js`** — `CACHE_VERSION` bumped 31 → 32.

### Notes
- **No firestore.rules / functions changes.** Pure file/nav cleanup. The legacy `purchaseRequests` Firestore collection rules stay in place (no live writers, but data may exist).
- **Net page reduction:** 51 → 49 user-facing pages. ~525 LOC of unused JS removed.

## [V3.56] - 2026-05-05

**Split View** — new general-purpose split-pane shell that lets the user open any two RM pages side-by-side in iframes. Adapted from the lab-apps.js `_splitAppId` / `_splitRatio` harness preserved through V3.53 cleanup specifically as reference for this work — explicitly flagged on the user's V3.40 follow-up list ("we really like the ability to have multiple pages open in a split view"). Plan doc: [CodeLog/ClaudesPlan/V3.56_split_view.md](../ClaudesPlan/V3.56_split_view.md).

### Added
- **`rm/pages/split-view.html`** — full-viewport shell. RM contract header (firebase SDK + firebase-bridge + adapter + cache + nav) + `<div id="split-root">` + `nav.js` + `split-view.js`. `body.has-split-view` makes the body itself a vertical flex container so `#split-root` fills the viewport below the nav.
- **`rm/js/split-view.js`** (~190 LOC) — URL-state read/write (single source of truth: `?left=...&right=...&ratio=N`), page-registry flattening from `nav.js`'s `NAV_ITEMS` (split-view.html itself filtered out to prevent recursion), two-pane render with per-pane header (page-swap dropdown + reload + open-full + close), divider pointer-drag with ratio clamped `[0.15, 0.85]`, ratio applied via `flex-basis` (no full re-render). Same-origin iframes auto-share Firebase IndexedDB persistence — no postMessage handshake needed (unlike the V3.40 iframe-bridge era under `/apps/`).
- **`rm/css/split-view.css`** (~120 LOC) — `.split-shell` (full-viewport flex), `.split-pane` (column flex with iframe filling), `.split-pane-header` (compact control bar), `.split-divider` + `.split-divider-grip`, `body.split-dragging` overlay (suppresses iframe pointer events during drag so the drag isn't captured by inner pointer handlers). Mobile media query (`max-width: 700px`) stacks vertically with horizontal divider.

### Changed
- **`rm/js/nav.js`** — added top-level `{ label: '⊟ Split', href: '/rm/pages/split-view.html' }` entry. Visually distinct from the regular section dropdowns (no children; leading `⊟` glyph).
- **`sw.js`** — `CACHE_VERSION` bumped 30 → 31.

### Notes
- **No firestore.rules / functions changes.** The split shell is pure DOM glue — no Firestore reads, no Cloud Function calls. Pages loaded inside the iframes touch Firestore the same way they do when loaded directly.
- **Trade-offs:** Each iframe re-loads the full RM bundle (~500KB), so two iframes is ~1MB total. Acceptable for an opt-in mode; future V3.57+ enhancement could convert to direct-mount (per-page renderer-as-function pattern) to eliminate duplication. Each iframe also shows its own RM top nav inside the pane — functional but visually busy. A future enhancement can pass `?embed=1` to the iframe and have `nav.js` skip rendering when present.
- **Migration follow-ups list shrinks to 1:** optional Firestore-backed OAuth tokens (V3.57). Workflow-driven page restructuring stays explicitly deferred per user guidance.

## [V3.55] - 2026-05-05

Scheduler: **My Schedule tab** lifted from the deleted `/apps/scheduler/app.js` into [rm/pages/scheduler.html](../../rm/pages/scheduler.html) — closes the V3.47 deferred work. With ScheduleService + CalendarService + ScheduleUtils brought into RM in V3.51 and the V3.54 Calendar Sync tab giving users a way to connect calendars, the personal calendar with layered availability + Google/Outlook/Apple overlay is finally live as an RM-native feature. Plan doc: [CodeLog/ClaudesPlan/V3.55_scheduler_my_schedule_tab.md](../ClaudesPlan/V3.55_scheduler_my_schedule_tab.md).

**Default tab is `schedulers`** (preserves V3.47 page behavior — users land on My Schedulers and click into My Schedule on demand).

### Added
- **`rm/js/scheduler.js`** — grew 462 LOC → 1,246 LOC. Three changes:
  - **Tab state + service aliases**: `_currentTab`, `_weekOffset`, `_schedMode`, `_schedZoomIdx`. `SS()` / `SU()` / `CS()` lazy lookups for `McgheeLab.ScheduleService` / `.ScheduleUtils` / `.CalendarService` (null when scripts aren't loaded — graceful degrade). `lockIcon()` / `calIcon()` helpers.
  - **Render dispatcher rewrite**: `render()` now emits a tab bar + `<div id="sched-tab-content">` container, then dispatches to `renderSchedulersTab(container)` (existing V3.47 code, now wrapped) or `renderMyScheduleTab(container)`. Tab switch resets `_view='list'` so the editor doesn't resume into a half-loaded state.
  - **Boot extension**: after `firebridge.whenAuthResolved()`, init ScheduleService + CalendarService (each guarded `if (SS())` / `if (CS())` so they no-op when scripts aren't loaded). Subscribe to `onChange` callbacks: re-render My Schedule content only when active tab matches.
  - **My Schedule code** lifted **720 LOC verbatim** from `/apps/scheduler/app.js` lines 191–908 (the complete `renderMyScheduleTab` / `renderMyScheduleContent` / `renderMyScheduleHTML` / `wireMySchedule` + four block-editor / custom-event modal helpers: `showNewScheduleBlockModal`, `showScheduleBlockEditor`, `showCustomEventModal`, `showEditCustomEventModal`). Patches via sed: `appEl.querySelector(All)` → `root.querySelector(All)`. Trailing section divider stripped.

### Changed
- **`sw.js`** — `CACHE_VERSION` bumped 29 → 30.

### Notes
- **`rm/css/scheduler.css` unchanged.** The V3.47 lift was a verbatim copy of `/apps/scheduler/styles.css` which already included the `.ms-*` selectors used by the My Schedule tab. The V3.47 plan doc explicitly noted: *"Includes `.ms-*` classes that the deferred My Schedule tab uses — they ride along now so V3.51 doesn't have to re-import the CSS."* Pays off here.
- **`rm/pages/scheduler.html` unchanged.** V3.51 already wired the script tags for `schedule-utils.js` / `schedule-service.js` / `calendar-service.js` + GIS client.
- **No firestore.rules changes.** ScheduleService writes to `huddleScheduleTemplates/{userId}` (line 299 — owner write), `huddleScheduleOverrides/{id}` (line 307 — owner manage), `scheduleCustomEvents/{id}` (line 288 — owner manage). All in place since V3.40.
- **Migration follow-ups list shrinks to 2:** split-view RM feature per user wishlist (V3.56), optional Firestore-backed OAuth tokens (V3.57). Workflow-driven page restructuring stays explicitly deferred per user guidance.

## [V3.54] - 2026-05-05

Settings: **Calendar Sync tab** added — closes the V3.48 deferred work. Lifts the lab-app `/apps/settings/` Calendar Integration UI into [rm/pages/settings.html](../../rm/pages/settings.html) as a new tab between Notifications and All Connections. Three provider cards (Google / Outlook / Apple), auto-refresh interval, Sync to Huddle toggle. Drives the `McgheeLab.CalendarService` singleton brought into RM in V3.51. Plan doc: [CodeLog/ClaudesPlan/V3.54_settings_calendar_tab.md](../ClaudesPlan/V3.54_settings_calendar_tab.md).

**Tab key collision dodge:** the existing connection-registry tab at key `'calendar'` (filters `connections.type === 'calendar'`) is unrelated to the new CalendarService UI. New tab uses key `'cal-sync'` to keep both clear.

### Added
- **`rm/js/settings.js`** — grew from 425 LOC to 788 LOC. New `cal-sync` entry in `TABS`. `_isConnectionTab()` updated to also exclude `cal-sync`. New `_isConnectionTabKey(k)` helper for tab-bar label counting. New dispatcher branch routes `activeTab === 'cal-sync'` to:
  - `renderCalendarSync(content)` — three provider cards (Google / Outlook / Apple), sync settings (refresh interval select + Sync to Huddle toggle), Save button + status pill. Adapted from the lab-app's `renderCalendarSection()` with the V3.41/V3.47/V3.49/V3.50/V3.52 RM-idiom pattern (`.cal-card` / `.btn` / `.btn-primary` / `.proc-btn-danger` / `.settings-toggle-row` / `.settings-status`).
  - `wireCalendarSync(cal)` — handlers for Google connect/disconnect, Outlook ICS file/URL/OAuth, Apple ICS file/URL, save sync settings (`cal.saveConfig({ autoRefreshMinutes, huddle: { autoBlock } })` + `cal.startAutoRefresh(refreshMinutes)`).
  - `_googleIcon()` / `_outlookIcon()` / `_appleIcon()` — inlined SVG icon helpers (lifted from lab app).
- **`rm/css/settings.css`** — added `.cal-providers` (auto-fit grid), `.cal-card`, `.cal-header`, `.cal-icon`, `.cal-badge` + `.cal-badge--on` (green-bg when connected), `.cal-body`, `.cal-row`, `.cal-actions`, `.cal-hint`, `.cal-details`, `.cal-select`. Local copy of `.proc-btn-danger` (lifted from procurement.css) so the Disconnect / Clear buttons get the red-tint danger state without depending on procurement.css being loaded on this page.

### Changed
- **`rm/pages/settings.html`** — added `<script src="/rm/js/calendar-service.js">` between `forms.js` and `settings.js` so `McgheeLab.CalendarService` is defined when `settings.js` runs. The GIS client (already loaded for the existing connection-registry OAuth handling) covers `cal.connectGoogle()`'s GIS token-client requirement.
- **`sw.js`** — `CACHE_VERSION` bumped 28 → 29.

### Notes
- **No firestore.rules / storage.rules / functions changes.** CalendarService persists its config in `userSettings/{uid}.calendar` (owner-only rule already in place at [firestore.rules:85](../../firestore.rules#L85)). OAuth tokens stay in `sessionStorage` per V3.51's decision (Firestore-backed token storage remains a future-V3.5x enhancement).
- **Migration follow-ups list shrinks to 3:** Scheduler My Schedule tab (V3.55), split-view RM feature per user wishlist (V3.56), optional Firestore-backed OAuth tokens (V3.57). Workflow-driven page restructuring stays deferred.

## [V3.53] - 2026-05-05

**Phase C cleanup** — closes out the lab-apps-into-RM migration. Every lab app at `/apps/<name>/` either had a native RM page that superseded it or had been deleted as a stub during Phase B (V3.41–V3.52). V3.53 deletes the now-redundant `/apps/` tree outright, removes the orphaned `lab-apps.js` script load from the public site, drops `APPS_CACHE` from the service worker, migrates remaining `/#/apps/<name>` URL references to `/rm/pages/<name>.html`. Plan doc: [CodeLog/ClaudesPlan/V3.53_phase_c_cleanup.md](../ClaudesPlan/V3.53_phase_c_cleanup.md).

**Per user guidance:** `lab-apps.js` itself stays in the repo (the `_splitAppId` / `_splitRatio` split-view harness is reference material for a future RM split-view feature). The public-site SPA's `#/dashboard` / `#/admin` / `#/cv` / `#/guide` routes also stay — those will be re-homed during a future workflow-driven page restructuring.

**Requires `firebase deploy --only functions` after merge** alongside the FTP push — Cloud Functions generate push-notification deep-links that need to point at the new `/rm/pages/` URLs.

### Removed
- **`apps/`** — entire directory tree. 8 subdirs: activity-tracker, chat, equipment, huddle, meetings, scheduler, settings, shared. Every app has a native RM page (V3.41 / V3.49 / V3.50 / V3.51 / V3.52 ports + V3.47 scheduler subset + V3.48 settings tabs); shared services were copied into `/rm/js/` in V3.51 (calendar-service, schedule-service, schedule-utils) and V3.49 (rm-categories).
- **`rm/pages/app-*.html`** — 5 redirect wrappers (app-chat.html, app-equipment.html, app-huddle.html, app-meetings.html, app-scheduler.html). Each was already a `<meta refresh>` redirect to its native target after Phase B per-port flips.

### Changed
- **`index.html`** — `<script defer src="lab-apps.js">` removed. Comment in place explaining the file is preserved for the split-view harness reference.
- **`sw.js`** — `APPS_CACHE` constant + `ALL_CACHES` membership + the runtime stale-while-revalidate routing for `/apps/*` all dropped. `/lab-apps.js` removed from `SHELL_URLS`. `CACHE_VERSION` bumped 27 → 28; the activate handler evicts every `mcgheelab-apps-v*` cache from prior versions on first navigation post-deploy.
- **`manifest.json`** — `start_url` migrated `/#/apps` → `/rm/`. Four `shortcuts[].url` entries migrated from `/#/apps/<name>` → `/rm/pages/<name>.html` (Activity Tracker, Lab Chat, Equipment Scheduler, The Huddle).
- **`functions/equipment.js`** (lines 35, 62, 72), **`functions/huddle.js`** (lines 44, 60, 80, 104, 136), **`functions/chat.js`** (line 49), **`functions/test-notifications.js`** (lines 18, 24, 30, 36, 42, 48, 54, 60, 66, 72) — push-notification deep-link `url` fields migrated from `/#/apps/<name>` → `/rm/pages/<name>.html`. The chat channel deep-links preserve the `?channel=${channelId}` query param.
- **`functions/calendar-proxy.js`** (line 7 comment) — reference updated from `apps/shared/calendar-service.js` → `/rm/js/calendar-service.js`.

### Notes
- **`lab-apps.js` preserved** for future split-view feature work (per user guidance). Unloaded — the dead lab-app-iframe code doesn't run anywhere — but the file is in the repo as reference for a general RM split-view harness.
- **No firestore.rules / storage.rules changes.** The same writes that came from the lab apps now come from the ported RM pages, with the same lab-member identity and rule eligibility.
- **PWA shortcuts** — users with the app installed will see updated home-screen shortcuts on next reinstall (manifest changes don't propagate live).
- **Migration complete.** After V3.53 the public-facing footprint is: marketing SPA at `/`, RM dashboard at `/rm/`, `/lab-apps.js` (unloaded), no `/apps/`. All 12 lab apps that started this migration are now native RM pages or have been retired.

## [V3.51] - 2026-05-05

**Equipment native port** + **shared services brought into RM**, lighting up four deferred features in one go. Replaces the V3.40 iframe wrapper at [rm/pages/app-equipment.html](../../rm/pages/app-equipment.html) with a native renderer at [rm/pages/equipment.html](../../rm/pages/equipment.html), and copies CalendarService / ScheduleService / ScheduleUtils from `/apps/shared/` into `/rm/js/`. Three deferred-feature pages (huddle, activity-tracker, scheduler) load the new services via `<script>` tags and their previously-degraded sections light up. Plan doc: [CodeLog/ClaudesPlan/V3.51_equipment_native_plus_shared_services.md](../ClaudesPlan/V3.51_equipment_native_plus_shared_services.md).

**Re-scope from the original V3.51 plan:** the V3.40 plan called this "equipment + sessionStorage→Firestore OAuth token refactor". On execution the token refactor turned out to be a pure enhancement (sessionStorage works fine for re-OAuth-once-per-session), not a blocker. V3.51 ports equipment + brings services in verbatim. Token-storage refactor moves to V3.53+ if/when appetite warrants.

**Phase B is now complete.** Only V3.53 Phase C cleanup remains (delete `/apps/` outright, drop `lab-apps.js`, lift the lab-app Calendar UI into RM settings as a third tab, lift the My Schedule tab UI onto `rm/pages/scheduler.html`, optional Firestore-backed token storage).

### Added
- **`rm/js/equipment.js`** (2,273 LOC) — copy of [/apps/equipment/app.js](../../apps/equipment/app.js) with five surgical patches (the now-standard playbook):
  - `window.McgheeLab = window.McgheeLab || {}` at top.
  - Container id `#app` → `#equipment-root`.
  - `db()` prefers `firebridge.db()` with `firebase.firestore()` fallback.
  - Bootstrap rewrite — replaces dual AppBridge / direct-Firebase path with `firebridge.gateSignedIn → whenAuthResolved → Promise.all([loadSettings, loadTraining, loadUsers]) → render → subscribeEquipment + subscribeUsers`. `MobileShell.enableTabSwipe` stays guarded. `firebridge.onAuth` re-renders on role flips so newly-promoted admins see the Admin tab without a manual reload.
  - `notifyResize()` AppBridge guard — patched from `if (!McgheeLab.AppBridge.isEmbedded()) return;` to also null-check `AppBridge` itself + `.isEmbedded`.
- **`rm/css/equipment.css`** (1,219 LOC) — full lift of [/apps/equipment/styles.css](../../apps/equipment/styles.css) plus `body { ... }` CSS-var aliases header and `.app-*` base classes (matching V3.41 / V3.47 / V3.49 / V3.50 / V3.52).
- **`rm/pages/equipment.html`** — RM contract header + GIS client (for admin Calendar push-sync) + equipment.js. Page chrome via `<div id="equipment-root">`.
- **`rm/js/calendar-service.js`** (536 LOC) — verbatim copy of [/apps/shared/calendar-service.js](../../apps/shared/calendar-service.js). Self-attaches to `window.McgheeLab.CalendarService`. Manages multi-provider calendar integration (Google OAuth, Microsoft MSAL, ICS imports) with sessionStorage-backed tokens.
- **`rm/js/schedule-service.js`** (418 LOC) — verbatim copy. Self-attaches to `window.McgheeLab.ScheduleService`. Owns Firestore subscriptions to `huddleScheduleTemplates`, `huddleScheduleOverrides`, `scheduleCustomEvents`; resolver merges template + override + custom-event + calendar events for a given user/day.
- **`rm/js/schedule-utils.js`** (156 LOC) — verbatim copy. Pure date / time utilities (`getWeekDays`, `fmtTime`, `timeToSlot`, `slotToTime`, `USER_COLORS`, `ZOOM_LEVELS`).

### Changed
- **`rm/js/nav.js`** — Operations → Equipment now points at `/rm/pages/equipment.html` (was `/rm/pages/app-equipment.html`).
- **`rm/pages/app-equipment.html`** — Phase A iframe wrapper replaced with `<meta refresh>` redirect.
- **`rm/pages/huddle.html`** — added GIS client + `schedule-utils.js` + `schedule-service.js` + `calendar-service.js`. **Lights up the Lab Schedule tab** (`teamavail`) deferred from V3.50: Team Availability Gantt overlays Google Calendar events, recurring availability templates editable, per-week overrides functional.
- **`rm/pages/activity-tracker.html`** — added GIS client + `calendar-service.js`. **Lights up the calendar-suggest panel** on the Daily view deferred from V3.49: connect Google Calendar and have today's events suggested as activity entries.
- **`rm/pages/scheduler.html`** — added GIS client + 3 service script tags. The V3.47 port covered My Schedulers only; supporting infrastructure is now in place so V3.53 can lift the My Schedule tab UI on top.
- **`sw.js`** — `CACHE_VERSION` bumped 26 → 27.

### Notes
- **No firestore.rules changes.** All collections used by equipment + the shared services already have rules in place: `equipment` (line 347), `equipmentBookings` (line 354), `equipmentTraining` (line 362), `equipmentSettings` (line 368), `huddleScheduleTemplates` (line 299), `huddleScheduleOverrides` (line 307), `scheduleCustomEvents` (line 288).
- **Token storage stays in sessionStorage.** Admin's Google Calendar OAuth token (equipment push-sync) and per-user Calendar / Outlook tokens (huddle / activity-tracker / scheduler import) all survive the page lifetime via `sessionStorage`. Re-OAuth once per browser session, same UX as the standalone lab app. Firestore-backed token storage is V3.53+ scope.
- **`/apps/equipment/` and `/apps/shared/` stay alive.** Standalone URLs still resolve. V3.53 Phase C cleanup deletes every remaining `/apps/` directory.
- **Settings Calendar tab deferred to V3.53.** Larger UI lift than fits here; the three other deferred features were just-script-tag wiring.

## [V3.52] - 2026-05-05

Lab Chat **native RM port** — replaces the V3.40 iframe wrapper at [rm/pages/app-chat.html](../../rm/pages/app-chat.html) with a native renderer at [rm/pages/chat.html](../../rm/pages/chat.html). The largest single port in the migration (3,650 LOC + 1,983 LOC of CSS), but follows the same lift-and-patch playbook used for V3.41 meetings, V3.49 activity-tracker, V3.50 huddle. **No V3.51 OAuth deferral** — chat's Drive uploads flow through a Google Apps Script web app (`chatConfig.gdriveScriptUrl`), not per-user Google OAuth, so the file-attach modal continues to work end-to-end without bridging to the deferred CalendarService refactor. Plan doc: [CodeLog/ClaudesPlan/V3.52_chat_native.md](../ClaudesPlan/V3.52_chat_native.md).

### Added
- **`rm/js/chat.js`** (3,650 LOC) — copy of [/apps/chat/app.js](../../apps/chat/app.js) with five surgical patches:
  - `window.McgheeLab = window.McgheeLab || {}` at top so optional-chaining lookups for `MobileShell?.saveTabScroll` etc. don't ReferenceError.
  - Container id `#app` → `#chat-root`.
  - `db()` prefers `firebridge.db()` with `firebase.firestore()` fallback. `TS()` (`FieldValue.serverTimestamp`) unchanged.
  - **Bootstrap rewrite (lab `app.js` lines 137–208)** — replaces dual AppBridge / direct-Firebase / setInterval-poll path with the RM contract: `firebridge.gateSignedIn()` → `await firebridge.whenAuthResolved()` → `_user/_profile` from firebridge → `canAccessChat(_profile)` chat-specific guest gate → `loadConfig() / loadUsers() / loadUserMeta() / render()` → Firestore subscriptions (channels, read-state, users, config) → `initChatTabSwipe()`. `firebridge.onAuth` handles role flips so newly-promoted chat admins see admin affordances without a manual reload.
  - **`notifyResize()` AppBridge guard** — patched from `if (McgheeLab.AppBridge.isEmbedded())` to also null-check `AppBridge` itself + `.isEmbedded` so it no-ops cleanly without AppBridge defined.
- **`rm/css/chat.css`** (1,983 LOC) — full lift of [/apps/chat/styles.css](../../apps/chat/styles.css) plus `body { ... }` CSS-var aliases header and the `.app-card` / `.app-btn` / `.app-input` / `.app-label` / `.app-empty` / `.app-badge` classes the renderer expects (sourced from `/apps/shared/app-base.css`).
- **`rm/pages/chat.html`** — RM contract header (firebase SDK incl. `firebase-storage-compat` for legacy direct-upload fallback) + chat.js. Page chrome via `<div id="chat-root">`. Drive uploads route through Apps Script (`chatConfig.gdriveScriptUrl`); legacy `driveUrl` field on old messages still resolves alongside the modern `url` (Firebase Storage) field.

### Changed
- **`rm/js/nav.js`** — Operations → Chat now points at `/rm/pages/chat.html` (was `/rm/pages/app-chat.html`).
- **`rm/pages/app-chat.html`** — Phase A iframe wrapper replaced with a `<meta refresh>` redirect to the native page so bookmarks pinned to the iframe URL still land correctly. Phase C deletes the redirect alongside the rest of the `app-*.html` wrappers.
- **`sw.js`** — `CACHE_VERSION` bumped 25 → 26.

### Notes
- **No firestore.rules changes.** All five chat collections + `users/{uid}/pushTokens` already have rules in place: `chatConfig` ([line 383](../../firestore.rules#L383)), `chatChannels` ([line 389](../../firestore.rules#L389)), `chatMessages` ([line 398](../../firestore.rules#L398)), `chatReadState` ([line 409](../../firestore.rules#L409)), `chatUserMeta/{uid}` owner-only ([line 414](../../firestore.rules#L414)). Chat-admin helper `isChatAdmin()` at line 376 reads `chatConfig.chatAdmins`, so promoting a non-admin to chat admin just means adding their uid to that list — no rule change.
- **`/apps/chat/` stays alive** as a fallback. Phase C deletes `/apps/` entirely once V3.51 (the only remaining native port) lands.
- **Chat-specific guest gate preserved.** `canAccessChat(_profile)` lets admin enable chat for a guest user without flipping their role in `users/{uid}` — useful for external collaborators who join a single channel but aren't full lab members.
- **No LIVE_SYNC.attach.** The renderer's `subscribeChannels` / `subscribeReadState` / `subscribeUsers` / `subscribeConfig` use Firestore `onSnapshot` directly. Layering LIVE_SYNC would duplicate work.
- **After V3.52, only V3.51 remains** — equipment port + the OAuth refactor that brings CalendarService + ScheduleService into RM and unblocks five deferred features (My Schedule on scheduler, Calendar Integration on settings, Calendar import on activity-tracker, Lab Schedule view on huddle, plus the equipment port itself). Then Phase C cleanup deletes `/apps/` entirely.

## [V3.50] - 2026-05-05

The Huddle **native RM port (subset)** — replaces the V3.40 iframe wrapper at [rm/pages/app-huddle.html](../../rm/pages/app-huddle.html) with a native renderer at [rm/pages/huddle.html](../../rm/pages/huddle.html). Same lift-and-patch playbook as V3.41 meetings + V3.49 activity-tracker: copy the lab `app.js` (2,888 LOC), surgically patch the bootstrap + container id + db helper + a couple of AppBridge references, leave the 2,800 LOC of view + Firestore subscription code unchanged. The Lab Schedule view (Team Availability Gantt + recurring availability templates) is intentionally deferred to V3.51 alongside the equipment OAuth refactor — the renderer null-checks every `ScheduleService` / `CalendarService` call so the section degrades gracefully (empty Gantt) until V3.51 lands. Plan doc: [CodeLog/ClaudesPlan/V3.50_huddle_native.md](../ClaudesPlan/V3.50_huddle_native.md).

### Added
- **`rm/js/huddle.js`** (2,918 LOC) — copy of [/apps/huddle/app.js](../../apps/huddle/app.js) with five surgical patches:
  - `window.McgheeLab = window.McgheeLab || {}` at top so optional-chaining lookups for `MobileShell?` / `CalendarService?` / `ScheduleService?` don't ReferenceError.
  - Container id `#app` → `#huddle-root`.
  - `db()` prefers `firebridge.db()` with `firebase.firestore()` fallback.
  - **Bootstrap rewrite** — replaces dual AppBridge / direct-Firebase path with `firebridge.gateSignedIn()` → `await firebridge.whenAuthResolved()` → `loadSettings()` → `render()` → `subscribePlans/Help/Rundown/RundownConfig`. `CalendarService.init` and `ScheduleService.init` stay guarded so they no-op without the services. Profile-role flips trigger re-render via `firebridge.onAuth`.
  - **`notifyResize()` AppBridge guard** — patched from `if (McgheeLab.AppBridge.isEmbedded())` to also null-check `AppBridge` itself + `.isEmbedded` so it no-ops cleanly without AppBridge defined (RM is the parent window — no iframe-resize postMessage to fire anyway).
- **`rm/css/huddle.css`** (1,876 LOC) — full lift of [/apps/huddle/styles.css](../../apps/huddle/styles.css) plus `body { ... }` CSS-var aliases header and the `.app-card` / `.app-btn` / `.app-input` / `.app-label` / `.app-empty` / `.app-badge` classes the renderer expects (sourced from `/apps/shared/app-base.css`). Same pattern as V3.41 meetings + V3.47 scheduler + V3.49 activity-tracker.
- **`rm/pages/huddle.html`** — RM contract header (firebase SDK + firebase-bridge + adapter + cache + nav) + huddle.js. No Chart.js (huddle doesn't use it); no rm-categories.js (huddle has its own DEFAULT_RUNDOWN_CATEGORIES baked into the renderer + admin-editable `huddleConfig.rundownCategories`).

### Changed
- **`rm/js/nav.js`** — Operations → Huddle now points at `/rm/pages/huddle.html` (was `/rm/pages/app-huddle.html`).
- **`rm/pages/app-huddle.html`** — Phase A iframe wrapper replaced with a `<meta refresh>` redirect to the native page so bookmarks pinned to the iframe URL still land correctly. Phase C deletes the redirect alongside the rest of the `app-*.html` wrappers.
- **`sw.js`** — `CACHE_VERSION` bumped 24 → 25.

### Notes
- **No firestore.rules changes.** All collections used by the huddle renderer already have rules in place: `huddlePlans` ([line 227](../../firestore.rules#L227)), `huddleHelpRequests` ([line 246](../../firestore.rules#L246)), `huddleSettings/{userId}` owner-only ([line 255](../../firestore.rules#L255)), `huddleRundown` ([line 272](../../firestore.rules#L272)), `huddleConfig` ([line 281](../../firestore.rules#L281)). The Lab Schedule collections (`huddleScheduleTemplates`, `huddleScheduleOverrides`, `scheduleCustomEvents`) are also in place for V3.51.
- **`/apps/huddle/` stays alive.** Standalone URL still resolves as a fallback for users who need the Lab Schedule view. V3.51 deletes the directory once OAuth lands.
- **No LIVE_SYNC.attach.** The renderer uses Firestore `onSnapshot` directly via `subscribePlans` / `subscribeHelp` / `subscribeRundown` / `subscribeRundownConfig`. Layering LIVE_SYNC over that would duplicate the work.

## [V3.49] - 2026-05-05

Activity Tracker **native RM port** — replaces the V3.40 iframe wrapper at [rm/pages/activity-tracker.html](../../rm/pages/activity-tracker.html). Same lift-and-patch pattern as V3.41 meetings: copy the lab `app.js` (2,100 LOC), surgically patch the bootstrap + container id + db helper, leave the 2,000 LOC of view + ML + AI + Chart.js code unchanged. Calendar Integration is deferred to V3.51 alongside the equipment OAuth refactor — the renderer's calendar-suggest panel uses optional chaining (`McgheeLab.CalendarService?.getEventsForDate`) so it stays empty without the service loaded; everything else (daily logging, hierarchical category tree, ML categorization, Anthropic API integration, voice input, Huddle plan integration, weekly analytics) ports verbatim. Plan doc: [CodeLog/ClaudesPlan/V3.49_activity_tracker_native.md](../ClaudesPlan/V3.49_activity_tracker_native.md).

### Added
- **`rm/js/activity-tracker.js`** (2,123 LOC) — copy of [/apps/activity-tracker/app.js](../../apps/activity-tracker/app.js) with four surgical patches:
  - `window.McgheeLab = window.McgheeLab || {}` at top so optional-chaining lookups for `MobileShell?` / `CalendarService?` / `RmCategories?` don't ReferenceError.
  - Container id `#app` → `#tracker-root` (avoids collision with other RM pages that use `#app`).
  - `db()` prefers `firebridge.db()` when available, falls back to `firebase.firestore()`.
  - **Bootstrap rewrite** — replaces the dual AppBridge / direct-Firebase path (lines 120–178 of the lab app) with the RM contract: `firebridge.gateSignedIn() → firebridge.whenAuthResolved() → loadData() → render()`. Mobile `enableTabSwipe` stays guarded so it no-ops without the lab shell. Profile-role flips trigger a re-render via `firebridge.onAuth`. No `LIVE_SYNC.attach` — user-scope + single-user-edit means a snapshot listener would only echo our own writes.
- **`rm/js/rm-categories.js`** (162 LOC) — verbatim copy of [/apps/shared/rm-categories.js](../../apps/shared/rm-categories.js). Bridge from RM's `labConfig/categorySchema` → array tree shape the tracker expects. No patches — uses `firebase.firestore()` directly. Phase C deletes `/apps/shared/` outright; the RM copy is the canonical version going forward.
- **`rm/css/activity-tracker.css`** (968 LOC) — full lift of [/apps/activity-tracker/styles.css](../../apps/activity-tracker/styles.css) (858 LOC) plus a `body { ... }` CSS-var aliases header (matching V3.41 meetings + V3.47 scheduler patterns) and the `.app-card` / `.app-btn` / `.app-input` / `.app-label` / `.app-empty` / `.app-badge` classes the renderer expects (sourced from `/apps/shared/app-base.css`).
- **`rm/pages/activity-tracker.html`** — was an iframe wrapper since V3.40; now a native page with the RM contract header + Chart.js CDN (jsdelivr UMD pin matches the lab app version) + rm-categories.js + activity-tracker.js. Page chrome via `<div id="tracker-root">`.

### Changed
- **`sw.js`** — `CACHE_VERSION` bumped 23 → 24.

### Notes
- **No firestore.rules changes.** All collections used by the tracker already have rules: `trackerData/{userId}` owner-only ([line 331](../../firestore.rules#L331)), `trackerEntries/{userId}/entries/{entryId}` owner-only ([line 337](../../firestore.rules#L337)), `huddlePlans` lab-member read ([line 227](../../firestore.rules#L227)), `labConfig/categorySchema` lab-member read ([line 448](../../firestore.rules#L448)).
- **`/apps/activity-tracker/` stays alive.** Standalone URL still loads as a fallback for users who need Calendar import. V3.51 deletes the directory once OAuth lands.
- **Chart.js loaded as global.** The renderer's analytics dashboard uses `new Chart(...)` directly — UMD CDN bundle satisfies that without renderer changes.
- **AI categorization keeps working.** Direct Anthropic API call (`https://api.anthropic.com/v1/messages`) using `_profile.anthropicKey` from `users/{uid}` — same path the lab app used; firebridge.getProfile() supplies the same shape.

## [V3.48] - 2026-05-05

Settings: **Profile + Notifications tabs** added to [rm/pages/settings.html](../../rm/pages/settings.html). Pulls the corresponding sections of `/apps/settings/` into RM. Settings becomes a one-stop shop for self-service config: edit display name + bio + Share Activity with PI, manage push-notification preferences (master toggle, 6 per-app toggles, quiet hours), and (still) maintain the connection registry. Calendar Integration + admin diagnostics + version checker stay in `/apps/settings/` for now (V3.51 sunsets that directory alongside the equipment OAuth refactor). Plan doc: [CodeLog/ClaudesPlan/V3.48_settings_profile_notifications.md](../ClaudesPlan/V3.48_settings_profile_notifications.md).

### Added
- **`rm/js/settings.js`** — refactored from 154 LOC to 425 LOC. New tab dispatcher, three render functions:
  - **`renderProfile()`** — fresh `firebridge.db().collection('users').doc(uid).get()` read for off-page-edit visibility, avatar (photo or initial-letter fallback), inputs for `name` + `bio`, switch for `shareActivity`. Save writes `{ name, bio, shareActivity, updatedAt }` via surgical `set(..., { merge: true })`.
  - **`renderNotifications()`** — reads `userSettings/{uid}` (default fallback when doc doesn't exist), renders 6 per-app push toggles (chat / meetings / equipment / huddle / scheduler / activityTracker) plus master + Do Not Disturb + quiet-hours time pickers. DnD toggle dims the time row live. Save writes a single nested `notifications: { enabled, quietHours: { enabled, start, end }, apps: { ... }: { push } }` patch via merge — same shape the lab app + Cloud Function notification triggers ([functions/helpers/notify.js](../../functions/helpers/notify.js)) already use.
  - **`renderConnections()`** — extraction of the existing inline connection-table render block, unchanged behavior.
  - `+ Add Connection` button hidden when Profile / Notifications is active; `add-item.onclick` defensively checks `_isConnectionTab()` against stale handlers.
- **`rm/css/settings.css`** — new page-scoped stylesheet (~140 LOC). `.settings-card`, `.settings-toggle-row`, CSS-only iOS-style `.settings-switch` (checkbox + faux track), `.settings-status` pills (success / error), `.settings-time-row` for the quiet-hours pickers, avatar styling. Uses RM CSS variables — no aliasing needed.

### Changed
- **`rm/pages/settings.html`** — added `<link rel="stylesheet" href="/rm/css/settings.css">` directly after the global stylesheet. No other markup changes.
- **`sw.js`** — `CACHE_VERSION` bumped 22 → 23.

### Notes
- **No firestore.rules changes.** Both writes target paths already covered: `users/{uid}` (line 96) for Profile; `userSettings/{uid}` (line 85) for Notifications. The `userSettings/{uid}` rule is owner-only (auth uid === userId), which matches V3.48's per-user write pattern.
- **`/apps/settings/` stays alive.** Calendar Integration there depends on CalendarService's Google OAuth flow — V3.51 scope. Until then, students who need to connect Google Calendar still hit `/apps/settings/` directly.
- **Cloud Function compatibility preserved.** [functions/helpers/notify.js](../../functions/helpers/notify.js) reads the same `userSettings/{uid}.notifications` schema; per-app toggles set in V3.48's UI continue to gate FCM sends correctly.

## [V3.47] - 2026-05-05

Scheduler **subset native port**: the *My Schedulers* tab (create + manage shareable scheduler links) lands at [rm/pages/scheduler.html](../../rm/pages/scheduler.html), backed by the existing stateless `/scheduler.js` engine. The *My Schedule* tab (calendar layers, recurring availability, Google Calendar OAuth) is intentionally deferred to V3.51 alongside the equipment OAuth refactor; the standalone `/apps/scheduler/` URL still resolves until then. Plan doc: [CodeLog/ClaudesPlan/V3.47_scheduler_subset_port.md](../ClaudesPlan/V3.47_scheduler_subset_port.md).

### Added
- **`rm/pages/scheduler.html`** + **`rm/js/scheduler.js`** (462 LOC) + **`rm/css/scheduler.css`** (full lift of [/apps/scheduler/styles.css](../../apps/scheduler/styles.css) plus a `body { ... }` CSS-var aliases header — same pattern as V3.41 meetings.css).
  - **List view**: `api.load('scheduler/list.json')` → client-side filter on `ownerUid` (admin sees all). `+ New Scheduler` opens an inline create form; `Manage` / `Delete` actions per row. `LIVE_SYNC.attach` on the list path so cross-tab creates / deletes update without manual reload.
  - **Editor view**: lifts the engine-mount logic from [/apps/scheduler/app.js:1088-1172](../../apps/scheduler/app.js#L1088-L1172). Loads the schedule + participants via direct firestore reads, builds the engine `config` with `onSaveSchedule` / `onSaveSpeaker` / `onAddSpeaker` / `onDeleteSpeaker` / `onRefresh` / `onSwitchView` callbacks, calls `McgheeLab.Scheduler.render(config)` then `wire('scheduler-editor-content', config)`. Surgical Firestore writes via `firebridge.db()` mirror the V3.41 / V3.44 patterns; `_live.suppressUntil` on each write.
  - **SDB layer**: `getSchedule` / `saveSchedule` / `deleteSchedule` (cascades deletes participants) / `getSpeakers` / `addSpeaker` (generates UUID key) / `updateSpeaker` / `deleteSpeaker` — direct ports of [/apps/scheduler/app.js:39-87](../../apps/scheduler/app.js#L39-L87).
- **`rm/js/api-routes.js`** — new lab-scope route `scheduler/list.json` → `collection: 'schedules', wrapKey: 'schedules', cache: MEDIUM`. shadowJson off (Firestore-only from day one). Editor view bypasses this route and queries direct so it picks up writes from concurrent users without invalidating the cached list.

### Changed
- **`rm/js/nav.js`** — Operations → Scheduler now points at `/rm/pages/scheduler.html` (was `/rm/pages/app-scheduler.html`).
- **`rm/pages/app-scheduler.html`** — Phase A iframe wrapper replaced with a `<meta http-equiv="refresh">` redirect to the native page so bookmarks pinned to the iframe URL still land correctly. Phase C deletes the redirect alongside the rest of the `app-*.html` wrappers.
- **`sw.js`** — `CACHE_VERSION` bumped 21 → 22.

### Notes
- **`firestore.rules` unchanged.** `schedules` (line 189) and `participants` (line 199) rules already permit V3.47's access pattern: public read (so guest invites resolve unauthenticated), owner-or-admin write on schedules, admin-or-key-or-speakerUid write on participants. No deploy needed.
- **Engine stays at `/scheduler.js`.** Same engine is used by the public-site SPA's `#/dashboard/scheduler` editor; duplicating into `/rm/js/` would create drift. Same-origin script loads from the RM page work fine.
- **`/apps/scheduler/` kept on disk** for the deferred My Schedule tab. V3.51 OAuth refactor + final sunset deletes the directory.

## [V3.46] - 2026-05-05

Compliance: `+ Submit Certificate` flow added to [rm/pages/compliance.html](../../rm/pages/compliance.html); lab-app `/apps/compliance/` retired. Same data shape (`complianceSubmissions` collection, identical fields) — admin-side Student Training tab, Verify button, expiry detection all unchanged. Plan doc: [CodeLog/ClaudesPlan/V3.46_compliance_submit_modal.md](../ClaudesPlan/V3.46_compliance_submit_modal.md).

This is the same audit-gap pattern V3.44 surfaced for purchases / procurement (RM admin pages were missing student-submission flows). Here the gap is small enough — one modal, one collection, no new page — that V3.46 both adds the flow and deletes the lab app in a single release rather than splitting across two phases.

### Added
- **`rm/js/compliance.js`** — three additions on top of the existing protocol-tracking renderer:
  - **Contextual button** (`_isAdmin()` + `_updateAddButton()`): the page-header `#add-item` button text/visibility now depends on `(activeTab, role)`. IRB/IACUC tabs show `+ Add Protocol` for admins (hidden for non-admins; collection is admin-write per firestore.rules). Training tab shows `+ Submit Certificate` for everyone.
  - **Per-role training query** (`renderTrainingTab` fork): admin path keeps `firebridge.getAll('complianceSubmissions',...)`. Non-admin path runs `firebridge.db().collection('complianceSubmissions').where('submittedBy','==',uid).orderBy('createdAt','desc').get()` — required because [firestore.rules:478](../../firestore.rules#L478) restricts read to `(own || isAdmin)`; a bare `getAll` would fail per-doc rule eval against any doc the user doesn't own. Empty state is friendlier for non-admins ("…click + Submit Certificate above to upload your first one"). The Verify button is gated on `_isAdmin()` so non-admins don't see a permission-denied button.
  - **`openSubmitCertModal()`** (~120 LOC): full cert-upload modal (type select, title, completion date, optional expiry, file input). Builds the modal directly because [forms.js](../../rm/js/forms.js) doesn't support file inputs. On submit: validates required fields, uploads to `compliance/{uid}/{Date.now()-rand}/<safeName>` in Storage (rule at [storage.rules:78](../../storage.rules#L78) — auth + 10 MB + PDF or image), writes to `complianceSubmissions` with `status: 'submitted'`, then switches `activeTab = 'training'` and re-renders so the user sees their new row immediately.
- **`rm/pages/compliance.html`** — `firebase-storage-compat` SDK added (page never used Storage before V3.46; comment in place flagging why).

### Removed
- **`apps/compliance/`** — full directory (`app.js` 135 LOC, `index.html`, `styles.css`). Same shape as the V3.42 console and V3.43 inventory deletions; the lab app's renderForm is now the openSubmitCertModal in compliance.js.
- **`lab-apps.js`** — `compliance` entry removed from `LAB_APPS` registry. After this release, the registry holds only the apps still slated for native ports (equipment, meetings, activity-tracker, huddle, scheduler, chat, settings).

### Changed
- **`sw.js`** — `CACHE_VERSION` bumped 20 → 21.

### Notes
- **No firestore.rules / storage.rules deploy needed.** The existing rules already permit the V3.46 access pattern (auth-create + read-own-or-admin on `complianceSubmissions`; auth-upload of PDF/image up to 10 MB on `compliance/{userId}/**`).

## [V3.45] - 2026-05-05

Retired the two student-submission lab apps replaced by V3.44's unified Procurement page. With V3.44 deployed (Firestore + Storage rules merged, static tree FTP'd), the burn-in window is over. Plan doc: [CodeLog/ClaudesPlan/V3.45_retire_purchases_procurement.md](../ClaudesPlan/V3.45_retire_purchases_procurement.md).

### Removed
- **`apps/purchases/`** — 126 LOC. Wrote to `purchaseRequests`. Replaced by the Submit Request tab in [rm/pages/procurement.html](../../rm/pages/procurement.html), which writes to the new `procurementTickets` collection.
- **`apps/procurement/`** — 337 LOC. Wrote to `procurement`. Replaced by the same procurement page; PO + receipt uploads now flow through the lifecycle modals on a single ticket.
- **`lab-apps.js`** — `procurement` and `purchases` entries removed from `LAB_APPS` registry (was lines 117–141).

### Notes
- **Legacy collections preserved:** `purchaseRequests` and `procurement` keep their existing data and remain readable. [rm/pages/purchase-requests.html](../../rm/pages/purchase-requests.html) and [rm/pages/receipts.html](../../rm/pages/receipts.html) (now nav'd as `Receipts & Budget`) still display the historical entries unchanged. New submissions go to `procurementTickets` via the V3.44 page.
- **firestore.rules unchanged.** The legacy collection rules (`purchaseRequests` at line 454, `procurement` at line 422) still permit reads for the admin pages. No deploy needed.

### Changed
- **`sw.js`** — `CACHE_VERSION` bumped 19 → 20.

## [V3.44] - 2026-05-05

New unified **Procurement** page covering the whole purchase lifecycle: request → approve → order (PO upload) → receive (mark from open-orders list, optional receipt) → place (record location) → inventory (auto-create item). One page, one collection (`procurementTickets`), one continuous audit trail per ticket. Plan doc: [CodeLog/ClaudesPlan/V3.44_procurement_tickets.md](../ClaudesPlan/V3.44_procurement_tickets.md). **Requires `firebase deploy --only firestore:rules,storage:rules` after merge** — the rules block for `procurementTickets` is brand-new; without the deploy the page will fail with permission-denied.

### Added
- **`rm/pages/procurement.html`** + **`rm/js/procurement.js`** (844 LOC) + **`rm/css/procurement.css`** — the unified procurement page. Tabs gated by role: `+ Submit Request` / `My Tickets` (everyone), `Pending` / `Awaiting Order` (admin), `Open Orders` / `Awaiting Placement` / `Archive` (everyone). Each tab renders ticket cards with status + urgency chips, lifecycle stamps, and stage-appropriate action buttons (Approve/Deny, Upload PO, Mark Received, Record Placement). Action modals capture: PO number + order date + ETA + PO file (PDF or image); actual cost + receipt file; location + qty + unit price + category for the inventory hand-off.
  - **Inventory bridge:** placement creates an `inventory/{newId}` doc with `kind: 'item'`, `procurementTicketId: ticket.id`, the location, quantity, and unit price. The ticket's `inventoryItemId` is stamped with the new doc id so the two stay linked.
  - **Live sync + surgical writes** following the V3.41 meetings pattern: `LIVE_SYNC.attach({paths: ['procurement/tickets.json', 'lab/users.json'], refresh: loadAndRender, tag: 'procurement'})`; every Firestore write sets `_live.suppressUntil = Date.now() + 2500`, mutates `_tickets` in-memory, and re-renders so the UI updates instantly without waiting for the snapshot echo.
  - **Storage uploads** under `procurement/{ticketId}/po-{ts}-{name}` and `procurement/{ticketId}/receipt-{ts}-{name}`. 20 MB cap; PDF or image.
- **`rm/js/api-routes.js`** — new lab-scope route `procurement/tickets.json` → `collection: 'procurementTickets', wrapKey: 'tickets', cache: SHORT`. SHORT TTL because pipeline state changes often.
- **`firestore.rules`** — new `match /procurementTickets/{ticketId}` block. `read`/`create`/`update` for `isLabMember()` (the lifecycle has multiple actors — requester, admin approver, anyone receiving, anyone placing — so the rule layer is permissive and the UI gates affordances; audit trail lives on `approvedBy` / `receivedBy` / `placedBy` / `updatedAt`). `delete` admin-only.
- **`storage.rules`** — existing `procurement/{docId}/{allPaths=**}` rule widened to accept `image/.*` alongside `application/pdf`. Same path now serves the legacy `procurement` collection's invoice PDFs and the V3.44 PO + receipt uploads (phone-photo receipts now allowed).

### Changed
- **`rm/js/nav.js`** — Lab Admin → `Procurement` link now points at `/rm/pages/procurement.html` (was `/rm/pages/receipts.html`). The receipts admin page is reachable via a new `Receipts & Budget` entry directly below — same target, clearer label.
- **`sw.js`** — `CACHE_VERSION` bumped 18 → 19.

### Notes
- **`/apps/purchases/` and `/apps/procurement/` stay alive in V3.44.** Cutover risk is real (students may have draft submissions in flight). V3.45 retires them once V3.44 is verified in production. The existing [rm/pages/purchase-requests.html](../../rm/pages/purchase-requests.html) admin-review page also stays for read-only burn-in of the legacy `purchaseRequests` collection.
- **Reorder reminder:** V3.44 was originally going to be a delete-and-redirect. The audit found the RM admin pages had no student-submission flow, so V3.44 became a greenfield build instead. V3.45+ revised plan: V3.45 retires the two lab apps; V3.46 compliance; V3.47 scheduler; V3.48–V3.52 unchanged.

## [V3.43] - 2026-05-05

Inventory stub deleted. Same shape as V3.42's console: 48-line "Coming Soon" placeholder with three section cards, no data layer, empty `wire()`. Meanwhile [rm/pages/inventory.html](../../rm/pages/inventory.html) is the real 903-LOC inventory system (8 tabs, 30+ subcategories, multi-location stock, LIVE_SYNC). Plan doc: [CodeLog/ClaudesPlan/V3.43_inventory_delete.md](../ClaudesPlan/V3.43_inventory_delete.md).

**Reorder:** V3.43 was originally purchases. On audit, the RM admin pages for purchases / procurement / compliance have **no student-submission form** — the lab apps are the only path students currently have to file purchase requests, submit receipts, and submit training certificates. Deleting them outright would create three parallel feature regressions. Each requires a "+ Submit" form to land on the corresponding RM page first (V3.44–V3.46), which is a meaningfully bigger lift than V3.42 / V3.43. Inventory is the rare overlap where the lab app is a pure stub, so it slotted in here.

### Removed
- **`apps/inventory/`** — entire directory (`app.js` 48 LOC, `index.html`, `styles.css`). All inventory functionality lives in [rm/pages/inventory.html](../../rm/pages/inventory.html); the lab-app stub was a placeholder that never delivered any of its three "promised" sections (Supplies / Equipment / Orders).
- **`lab-apps.js`** — `inventory` entry removed from `LAB_APPS` registry. Registry orphaned in the public nav since V3.40; maintained until Phase C.

### Changed
- **`sw.js`** — `CACHE_VERSION` bumped 17 → 18.

## [V3.42] - 2026-05-05

Console stub deleted. The lab app at `/apps/console/` was a 65-line "Coming Soon" placeholder — no data layer, no functionality, no Firestore reads/writes. Per the V3.40 audit, deletion (rather than a placeholder port) was the right call. Plan doc: [CodeLog/ClaudesPlan/V3.42_console_delete.md](../ClaudesPlan/V3.42_console_delete.md).

**Reorder:** V3.42 was originally scheduler. Scheduler is genuinely heavy (subset port still needs the 1,382-LOC engine) and warrants a dedicated session. Reslotted the trivial overlap-app deletions (V3.42–V3.46) ahead of it so the migration keeps momentum without bundling complexity. Scheduler is now V3.47.

### Removed
- **`apps/console/`** — entire directory (`app.js` 65 LOC, `index.html`, `styles.css`). Stub functionality (App Management / User Permissions / Integrations / Usage & Logs section cards) was never built; the four "promised" functions are accounted for elsewhere in RM (nav gating, future `rm/pages/admin.html`, [rm/pages/settings.html](../../rm/pages/settings.html), [rm/pages/api-usage.html](../../rm/pages/api-usage.html)).
- **`lab-apps.js`** — `console` entry removed from `LAB_APPS` registry (lines 53–65). Registry is orphaned in the public nav since V3.40; maintained until Phase C.

### Changed
- **`sw.js`** — `CACHE_VERSION` bumped 16 → 17.

## [V3.41] - 2026-05-05

Phase B begins — first native RM port of a lab app. **Meetings** moves off the V3.40 iframe wrapper onto the api.load + IndexedDB cache + LIVE_SYNC contract. **Reorder note:** the V3.40 plan listed scheduler first; on audit it depends on three shared modules (~2,500 LOC including CalendarService's Google OAuth) that would either front-load V3.51's OAuth refactor or ship a feature regression. Swapped V3.41 ↔ V3.42 — meetings is the cleaner proof-of-concept (only `meetings`/`meetingConfig`/`users` collections, no shared services). Plan doc: [CodeLog/ClaudesPlan/V3.41_meetings_port.md](../ClaudesPlan/V3.41_meetings_port.md).

### Added
- **`rm/js/meetings.js`** — 1,827-LOC native renderer ported from [/apps/meetings/app.js](../../apps/meetings/app.js). Bootstrap, data load, and live updates rewritten onto the RM contract; renderer logic lifted near-verbatim.
  - Bootstrap: `firebridge.gateSignedIn() → firebridge.whenAuthResolved() → loadAndRender() → LIVE_SYNC.attach()`. Live handle stored on `_live` so surgical writes can set `_live.suppressUntil` to skip the echo.
  - Data load: parallel `api.load('meetings/list.json')`, `api.load('meetings/config.json')`, `api.load('lab/users.json')`. `_meetings` sorts ascending by date; `_labMembers` filters out `role === 'guest'`.
  - Live updates: single `LIVE_SYNC.attach({paths: [...3 paths], refresh: loadAndRender, tag: 'meetings'})` replaces three separate `onSnapshot` listeners.
  - Writes (`saveConfig`, `createMeeting`, `updateMeeting`, `deleteMeeting`) use surgical `firebridge.db().collection(...).doc(id)...` direct writes mirroring the [rm/js/receipts.js:79-96](../../rm/js/receipts.js#L79-L96) pattern. Each write bumps `_live.suppressUntil = Date.now() + 2500` and then mutates `_meetings`/`_config` in-memory + calls `renderMain()` so the UI updates instantly without waiting for the suppress window.
  - `MobileShell.*` and `AppBridge.isEmbedded()` calls dropped — RM owns the top nav and full-page chrome; no `mcgheelab-app-resize` postMessage to fire.
  - Re-renders on `firebridge.onAuth` profile-role flips (guest → admin promotion shows Settings; meeting-admin promotion unlocks agenda toggles).
- **`rm/css/meetings.css`** — lifted from [/apps/meetings/styles.css](../../apps/meetings/styles.css) (1,203 LOC) plus the `.app-card` / `.app-btn` / `.app-input` / `.app-label` / `.app-empty` / `.app-badge` classes from [/apps/shared/app-base.css](../../apps/shared/app-base.css). A `body { ... }` block at the top aliases the lab-base CSS variables (`--muted`, `--accent`, `--accent2`, `--danger`, `--success`, `--warning`, `--surface2`, `--radius-lg`) to RM equivalents (`--text-muted`, `--primary`, `--primary-hover`, `--red`, `--green`, `--amber`, `#eef2f6`, `12px`) so every selector renders correctly without per-rule rewrites.
- **`rm/pages/meetings.html`** — RM contract header (runtime-mode → firebase SDK including storage → firebase-bridge → profile-bootstrap → local-cache → util → api-firestore-adapter → api-routes → live-sync-helper → toast → sync-status → nav → meetings.js). Page container is `<div id="mtg-root">` to avoid colliding with other RM pages that may use `#app`.
- **`rm/js/api-routes.js`** — two new lab-scope routes:
  - `meetings/list.json` → `collection: 'meetings', wrapKey: 'meetings', cache: MEDIUM`. `shadowJson` off (Firestore-only from day one; no JSON shadow).
  - `meetings/config.json` → `collection: 'meetingConfig', doc: 'settings', cache: LONG`. Single-doc route; LONG TTL because semester defaults / rotation order rarely change.

### Changed
- **`rm/js/nav.js`** — Operations → Meetings now points at `/rm/pages/meetings.html` (was `/rm/pages/app-meetings.html`).
- **`rm/pages/app-meetings.html`** — Phase A iframe wrapper replaced with a `<meta http-equiv="refresh" content="0;url=/rm/pages/meetings.html">` redirect so any bookmarks pinned to the iframe URL still land in the right place. Phase C deletes the redirect alongside the rest of the `app-*.html` wrappers.
- **`sw.js`** — `CACHE_VERSION` bumped 15 → 16.

### Notes
- **`firestore.rules` no-op.** The renderer reads/writes `meetings` (rules at line 317), `meetingConfig` (line 325), and `users` (already gated by `isLabMember()`) with the exact same field shapes the lab app used. No rule deploy needed.
- **`/apps/meetings/` kept on disk through Phase B.** Standalone URL still works as a fallback during the multi-version migration window. Phase C deletes it.
- **Phase B remainder reordered:** V3.42 = scheduler (subset port, defer CalendarService until V3.51), V3.43+ unchanged. See plan doc for the full revised table.

## [V3.40] - 2026-05-04

Phase A of the `/apps/` → RM migration. RM becomes the only nav home for lab tools; the public site loses its **Lab Apps** menu. Each unported app is reachable via an iframe-wrapped RM page until V3.41–V3.52 ports it natively. Plan doc: [CodeLog/ClaudesPlan/V3.40_rm_app_migration.md](../ClaudesPlan/V3.40_rm_app_migration.md).

### Added
- **Iframe-bridge wrappers in RM** — five new pages parameterized from the existing [rm/pages/activity-tracker.html](../../rm/pages/activity-tracker.html) postMessage pattern:
  - [rm/pages/app-chat.html](../../rm/pages/app-chat.html) → `/apps/chat/`
  - [rm/pages/app-equipment.html](../../rm/pages/app-equipment.html) → `/apps/equipment/`
  - [rm/pages/app-huddle.html](../../rm/pages/app-huddle.html) → `/apps/huddle/`
  - [rm/pages/app-meetings.html](../../rm/pages/app-meetings.html) → `/apps/meetings/`
  - [rm/pages/app-scheduler.html](../../rm/pages/app-scheduler.html) → `/apps/scheduler/`
  - Each preserves the null-profile guard (`p ? Object.assign({role: p.role || 'member'}, p) : {role: 'member'}`) — required to avoid stuck-load on first sign-in. Same-origin Firebase IndexedDB persistence means the wrapped app's own `firebase.auth()` already has the user; the postMessage just populates `auth-bridge.js`'s `_user`/`_profile`.

### Changed
- **`rm/js/nav.js`** — `NAV_ITEMS` rewritten into six top-level groups: `Dashboard | Activity | Research | Operations | Lab Admin | Settings`.
  - **Operations** (`gate: 'lab-member'`): Chat, Huddle, Meetings, Scheduler, Equipment — all routed through the new iframe wrappers above.
  - **Lab Admin** (`gate: 'lab-member'`): Compliance, Chemical Safety, Inventory, Lab Members, Important People, Career & Tenure, Procurement (receipts), Purchase Requests, Grant Accounts, Budget, Analytics, Travel — every link points at an existing native RM page.
  - **Settings** (`gate: 'lab-member'`): Profile, Settings, CV Overview, CV Editor, Member Activity (`gate: 'admin'`).
  - **Activity** keeps Tracker/Overview/Calendar/Email/Tasks/Sharing/Year (Task → Tasks for grammatical consistency).
  - **Research** absorbs Teaching and Service as submenu entries (was top-level before) to keep the bar at six items.
  - Existing per-item gating + auto-collapse-empty-group at lines 163-194 unchanged.
- **`sw.js`** — `CACHE_VERSION` bumped 14 → 15. The 33-entry `APP_URLS` precache list deleted along with the `caches.open(APPS_CACHE).then(addAll)` install step; install now precaches shell only. The `APPS_CACHE` constant + runtime stale-while-revalidate routing for `/apps/*` (line 213) **stay** so iframe loads still benefit from runtime caching during Phase A. Phase C deletes the constant when `/apps/` itself is removed.
- **`index.html`** — three `Lab Apps` `<li>` entries removed from the nav surfaces (drawer `nav-apps`, desktop `dnav-apps`, mobile sheet `more-apps`). The conditional `nav-rm`/`dnav-rm`/`more-rm` entries to the RM gateway stay; `nav-dashboard`/`dnav-dashboard` and `nav-admin`/`dnav-admin` are kept until Phase C.
- **`user-system.js`** — `Auth.updateNavigation()` no longer toggles `nav-apps`/`dnav-apps`/`more-apps` (line 661); the orphaned IDs stay hidden via their `display:none` markup if any external page still ships them.

### Documentation
- New [CodeLog/ClaudesPlan/V3.40_rm_app_migration.md](../ClaudesPlan/V3.40_rm_app_migration.md) — Phase A plan + Phase B (V3.41–V3.52) port order + per-overlap audit (compliance, inventory, settings, activity-tracker, procurement, purchases) listing the lab-app features that need to merge into the RM page before the lab-app version is deleted.
- [CodeLog/Architecture/ARCHITECTURE.md](../Architecture/ARCHITECTURE.md) — RM section updated to reflect the six-group nav and the iframe-bridge tier.

## [V3.39] - 2026-04-30

### Added
- **Slack → Lab Chat history export** (`scripts/slack_export.py`) — one-time script to migrate Slack workspace history into Lab Chat as a frozen archive during the transition off Slack
  - Pulls users, public + private channels, 1:1 DMs, group DMs, threads, reactions, and file attachments via Slack Web API (paid-tier user OAuth token)
  - Maps Slack users to Lab Chat UIDs by email; creates `users/slack_{slackId}` ghost docs (`imported: true`, `disabled: true`, `role: 'guest'`) for non-members so messages have a valid `authorUid`
  - Creates one `chatChannels/slack_{slackId}` doc per Slack conversation under a new `Slack archive` category (auto-added to `chatConfig/settings.categories`); DMs/MPIMs preserve `members` so existing Firestore rules gate visibility
  - Writes `chatMessages` matching the existing schema with new fields `importedFromSlack: true`, `slackTs`, `slackChannelId`, `importedBy`; idempotent on `slackTs` so re-runs skip duplicates
  - Two-pass thread import: pass 1 writes top-level messages and builds `slackTs → firestoreId` map; pass 2 writes replies with resolved `threadParentId` and updates parents' `threadReplyCount` / `threadLastReplyAt`
  - Files >50 MB skipped (matches `storage.rules` limit); others downloaded from `url_private_download` and re-uploaded to `chat/imported/{channelId}/{ts}_{name}` in Firebase Storage
  - Slack mrkdwn conversion: `<@U…>` mentions resolved to `@displayname` + `mentions: [uid]`; `<#C…>` to `#name`; `<url|label>` to `label (url)`; `<!channel>` etc. preserved as plain text but `mentionsChannel` forced false to avoid retroactive notification storms
  - Rate-limit handling (Tier 3 `conversations.history` ~50/min, sleeps on `Retry-After` 429s); checkpoint at `scripts/.slack_export_checkpoint.json` so partial runs resume per-channel
  - CLI flags: `--dry-run`, `--channels name1,name2`, `--skip-files`, `--skip-dms`
  - Env config via `scripts/.env` (template at `scripts/.env.example`); `.gitignore` updated to exclude env + checkpoint files
- **`apps/chat/app.js`** — message renderer adds `<span class="chat-badge-imported">from Slack</span>` next to the timestamp when `msg.importedFromSlack === true` (line ~1324 in `renderMessageHTML()`); no behavior change beyond the badge — imported messages stay read-only because their ghost `authorUid` doesn't match any signed-in user
- **`apps/chat/styles.css`** — `.chat-badge-imported` style (italic muted pill, matching the existing `.chat-badge-pin` shape)
- **`scripts/requirements.txt`** — `slack_sdk`, `firebase-admin`, `python-dotenv`, `requests`
- `sw.js`: `CACHE_VERSION` bumped 7 → 8

## [V3.38] - 2026-04-27

### Changed
- **`modules/manifest.json`** — synced bme576 file list with disk
  - Removed deleted entries: `01_experimental_design.html`, `01_parameter_estimation.html`
  - Added: `mc_interactive_explorer.html` (Module 10: Uncertainty & Error Propagation), `11_parameter_estimation.html`, `12_experimental_design.html` (Module 12: DOE), `13_model_validation.html` (Module 13: Model Validation)
  - Updated `generated` timestamp
- `sw.js`: `CACHE_VERSION` bumped 6 → 7

## [V3.37] - 2026-04-17

### Added
- **News posts: Team section** — news post editor now mirrors the research story editor with Author (readonly), Mentor dropdown, and Contributors chip picker
  - New post schema field `team: { author, mentor, contributors }` saved alongside legacy `authorName`/`authorUid`/`authorPhoto` (legacy fields retained for backwards compatibility with admin review and older posts)
  - Public news card's expanded area now renders the team grid (reuses `buildStoryTeamHTML()` via `buildExpandedHTML()`)
  - Editor controls: `#news-author-name`, `#news-mentor`, `#news-contributor-select`, `#news-add-contributor-btn`, `#news-contributor-chips`
- **News page: Filter bar** — above the feed, with Type (multi-select chips over `NEWS_CATEGORIES`), Person (dropdown from union of `authorName` + `team.author/mentor/contributors[].name`), Time (All / 30d / 3mo / 1yr chips), and "Has comments" toggle
  - Live "Showing N of M" count and "Clear filters" link
  - Client-side filter on the already-loaded posts; AND across groups, OR within Type
  - Comment counts prefetched once via `Promise.all(getCommentsByStory)` and stored on each post as `_commentCount`; powers the has-comments filter and card badges in a single round-trip (removes per-card fetch from `wireNewsFeedInteractions()`)
- `app.js` new functions: `buildNewsFilterBar()`, `collectNewsPeople()`, `postInvolvesPerson()`, `applyNewsFilters()`, `wireNewsFilters()`
- `styles.css`: `.news-filter-bar-inner`, `.news-filter-group`, `.news-filter-label`, `.news-filter-chips`, `.news-filter-chip(.active)`, `.news-filter-select`, `.news-filter-toggle`, `.news-filter-meta`, `.news-filter-count`, `.news-filter-clear` (+ 720px breakpoint)
- `sw.js`: `CACHE_VERSION` bumped 5 → 6

### Changed
- `buildNewsFeedCard()` expanded content now built via `buildExpandedHTML(newsBlocks, p)` (was `buildStoryHTML(newsBlocks)`) so team renders above sections
- `wireNewsFeedInteractions()` no longer fetches comment counts per card — uses prefetched `_commentCount`

## [V3.36] - 2026-04-17

### Added
- **Image lightbox on Research Stories and News pages** — click any content image (cover image or in-story/news section image) to open a full-screen viewer with zoom and pan
  - Zoom: mouse wheel (toward cursor), `+` / `1:1` / `-` toolbar buttons, `+` / `-` / `0` keys, double-click to toggle fit vs. 2.5×, 2-finger pinch on touch
  - Pan: drag (mouse or touch) when zoomed in
  - Close: X button, backdrop click, or Escape key
  - Single shared overlay lazily appended to `<body>` on first open; delegated click listener on `#stories-feed` and `#news-feed` survives feed re-renders
  - Skips small identity photos (`.story-feed-avatar`, `.story-team-photo`) and clicks inside buttons/links
- `app.js`: `ensureLightbox()`, `openImageLightbox(src, alt)`, `wireImageZoom(rootEl)`; hooked into `wireStoryFeedInteractions()` and `wireNewsFeedInteractions()`
- `styles.css`: `.img-lightbox`, `.img-lightbox-backdrop`, `.img-lightbox-stage`, `.img-lightbox-img`, `.img-lightbox-close`, `.img-lightbox-controls`, `.img-lightbox-btn`; `zoom-in` cursor on eligible images
- `sw.js`: `CACHE_VERSION` bumped 4 → 5

## [V3.35] - 2026-04-13

### Added
- **Scheduler: Custom Yes/No Questions for guests** — scheduler owners can define boolean checkbox questions (e.g., "Are you available for a lab tour?") that each invited guest answers alongside their availability
  - Admin UI in Schedule Settings → "Yes/No Questions" — dynamic list with `+ Add Question` / `Remove` buttons; stable per-question `id` preserves guest answers across text edits and deletions
  - Guest view: one checkbox per defined question in the Details card (card shows automatically when any questions are defined, even if all other guest fields are off)
  - Admin guest table gains a "Responses" column (`N/M` yes-count with full answer breakdown on hover)
  - Confirmed/public speaker cards show a "Confirmed" list of questions each guest answered yes to
  - Auto-generated guest instructions mention yes/no questions when defined
- **Schema additions**
  - `schedules/{id}.booleanQuestions: [{ id, text }]` — owner-defined question list (persisted via existing `onSaveSchedule`)
  - `participants/{key}.booleanAnswers: { [questionId]: true }` — sparse map; only stores checked answers so deleted questions auto-clean
- `scheduler.js` helpers: `newQuestionId()`, `booleanQuestionsEditorHTML()`, `booleanQuestionRowHTML()`; `confirmedSpeakersHTML()` now accepts `booleanQuestions` as a 5th param; `defaultGuestInstructions()` accepts `hasBoolQuestions` flag
- `apps/scheduler/app.js`: seeds `booleanQuestions: []` on new scheduler creation

## [V3.34] - 2026-04-11

### Added
- **Calendar: Busy-but-Available status** — calendar import events can be toggled between "Unavailable" (default, blocks availability) and "Busy but Available" (shows as partial availability)
  - Toggle button on calendar blocks in Scheduler's My Schedule grid (green/red circle icons)
  - Per-event status persisted in `userSettings/{uid}.calendar.eventStatuses`
  - `CalendarService.setEventStatus(eventId, status)` / `getEventStatus(eventId)` API
  - Busy-available events inject into `resolveScheduleForUser()` as `type: 'available'` instead of `type: 'unavailable'`
- **Activity Tracker: ML category suggestions on calendar import** — unlogged calendar events now show ML prediction pills (e.g., "Research", "Meetings") inline
  - Clicking a suggestion pill imports the event with that category pre-assigned and trains the ML model
  - Plain "Log it" button still works for uncategorized import
- **Firebase Cloud Function: `calendarProxy`** — server-side ICS fetch relay to bypass CORS restrictions on Outlook/Google/Apple calendar URLs
  - Domain-restricted to calendar providers only (prevents open proxy abuse)
  - Auto-converts `.html` calendar URLs to `.ics`; follows redirects; 5-min cache
  - First fetch strategy tried before client-side CORS proxies

### Changed
- **Scheduler: Mode renames** — "Recurring" → "General Availability", "Special Date" → "Special Availability", "Blackout" → "Special Unavailability" across mode selector, layer toggles, and block labels
- **Scheduler: Layer toggle labels** — external calendar layers now show provider names: "Google Calendar", "Outlook Calendar", "Apple / ICS Calendar" based on connected providers (with brand colors)
- **Team Availability: Layered visualization** — complete rewrite of segment rendering
  - Base layer: General Availability renders as green bar
  - Overlay layer: Calendar events (purple), custom events (user color), blackouts (reason color) render on top, subtracting from availability and showing context (event titles)
  - **Busy-but-available**: renders with slanted diagonal stripe pattern in muted green, showing the block is not fully unavailable
  - Rigid blocks retain striped pattern
- **Calendar events always subtract from availability** — removed `autoBlock` toggle gate; calendar events inject into `resolveScheduleForUser()` whenever any calendar provider is connected
- **Huddle: CalendarService initialized at boot** — `CalendarService.init()` + `CalendarService.onChange()` now called during huddle bootstrap; fixes calendar events not appearing in Team Availability
- **CalendarService: ICS fetches awaited during init** — `fetchICSFromUrl` calls in `init()` now use `await Promise.all()` instead of fire-and-forget; initial render has calendar data
- **Scheduler: CalendarService.onChange re-render** — scheduler registers `CS().onChange()` handler; fixes calendar events not showing until layer toggle cycled
- **CalendarService: Auto-convert HTML to ICS URLs** — Outlook `.html` calendar URLs automatically converted to `.ics` before fetching
- **Settings: Outlook calendar URL input promoted** — URL input moved from collapsed `<details>` to primary position; accepts both HTML and ICS links

### Bug Fixes
- **Activity Tracker loading screen** — `localDateStr()` function was accidentally removed with calendar code migration; restored as standalone utility
- **Settings calendar status messages invisible** — `showStatus()` was called before `render(); wire();` which destroyed the DOM element; moved to after re-render
- **Calendar events missing on initial load** — ICS URL fetches were fire-and-forget in `CalendarService.init()`; now awaited so data exists for first render

## [V3.33] - 2026-04-11

### Added
- **Scheduler: My Schedule Tab** — full-featured personal calendar with layered data
  - Tab bar: "My Schedule" (default) and "My Schedulers" (existing)
  - **Layer system**: Recurring (green), Overrides (blue/red), Calendar Events (purple), Custom Events (user-colored) — each toggleable
  - **Custom events** with title, color picker (12 presets), and weekly repeat toggle; stored in `scheduleCustomEvents` collection
  - **Calendar event dismissal** — dismiss imported events without affecting source calendar; persisted in `userSettings/{uid}.calendar.dismissedEventIds`
  - Mode selector, drag-to-create, block edit modals, week nav, zoom, "Copy Mon → Weekdays"
- **`apps/shared/schedule-utils.js`** — pure time/week utilities (getWeekDays, fmtTime, timeToSlot, etc.)
- **`apps/shared/schedule-service.js`** — schedule data layer: CRUD, Firestore subscriptions, `resolveScheduleForUser()`, `resolveAvailabilityOverlap()`, custom events, layer config
- **CalendarService: Event Dismissal** — `dismissEvent()`, `restoreDismissed()`, `getDismissedCount()`

### Changed
- **Huddle: My Schedule removed** — editing UI moved to Scheduler (~500 lines removed); Team Availability + Rundown overlap refactored to use shared `ScheduleService`

## [V3.32b] - 2026-04-11

### Added
- **Settings: Check for Updates button** — "App Version" section in Settings app with "Check for Updates" button; displays current cache version; checks for new service worker, prompts install if available, shows "You're on the latest version" if current; works in both embedded and standalone mode
- **SW `SKIP_WAITING` message handler** — `sw.js` now listens for `{ type: 'SKIP_WAITING' }` messages, allowing the Settings button to trigger immediate activation of a waiting service worker
- **Auto-bump SW cache version on deploy** — `version_push.py` now automatically increments `CACHE_VERSION` in `sw.js` before committing, ensuring installed PWAs detect and install updates; no manual bump needed

### Bug Fixes
- **Stale PWA after deploy** — installed desktop/mobile PWA could run permanently outdated code because the service worker had no proactive update mechanism; users had to manually uninstall and reinstall
  - **Periodic SW update check** — `index.html` SW registration now calls `reg.update()` every 30 minutes, ensuring the browser checks for a new `sw.js` regularly instead of only every 24h
  - **Visibility-based update check** — `visibilitychange` listener calls `reg.update()` when user returns to the tab/PWA, so resuming the app after being away immediately checks for updates
  - **Auto-reload on SW activation** — `controllerchange` listener on `navigator.serviceWorker` triggers `location.reload()` when a new SW takes control via `skipWaiting()` + `clients.claim()`; prevents "zombie tab" where old JS runs under new SW
  - **`updatefound` timing fix** — `app.js` update listener now checks for `state === 'installed'` (not `'activated'`) and also checks `reg.waiting` on page load; fixes race where `skipWaiting()` pushed the worker past `activated` before the listener bound, so the update toast never appeared
  - **SW precache expanded** — added `mobile-shell.js`, `calendar-service.js`, `schedule-service.js`, `schedule-utils.js` to `APP_URLS` precache list; bumped `CACHE_VERSION` to 2; prevents cache-miss network fetches for shared scripts on first app load
  - **Iframe re-render guard** — `app.js` `Auth.onChange` handler no longer calls `onRouteChange()` when an app iframe is already loaded (`#lab-app-frame` exists); prevents destroying a working iframe to recreate it when profile loads from Firestore
- `index.html` — SW registration stores `window.__swReg`, adds `setInterval` + `visibilitychange` update checks, adds `controllerchange` auto-reload
- `app.js` — `updatefound` listener checks `installed` state + `reg.waiting` on load; apps re-render guard checks `document.getElementById('lab-app-frame')`
- `sw.js` — `CACHE_VERSION` bumped to 2; added 4 shared scripts to `APP_URLS` precache

## [V3.32] - 2026-04-11

### Bug Fixes
- **Auth race condition on first login / cold start** — recurring bug where lab apps showed "Sign in required" auth wall even when the user was authenticated, especially on first-time login, page refresh, or PWA cold start
  - **Standalone grace period** — `auth-bridge.js` `_initStandalone()` no longer calls `_fireAuthFailed()` on the first `null` from `onAuthStateChanged`; instead waits 2s for Firebase persistence to restore the session from IndexedDB before treating null as a definitive sign-out
  - **Auth recovery path** — new `_authFailed` flag tracks whether the auth wall is showing; if `onAuthStateChanged` later delivers a real user after the wall appeared, `_fireReady()` triggers `location.reload()` to cleanly restart the app with valid credentials
  - **Embedded null-message guard** — embedded mode message handler no longer calls `_fireAuthFailed()` when parent sends `user: null`; relies on the 8s timeout for genuinely-unauthenticated case, giving the parent time to resolve auth
  - **Event-driven auth forwarding** — `lab-apps.js` `wireLabApp()` now registers an `Auth.onChange` listener that re-sends auth credentials to active iframes whenever the parent's auth state changes; replaces the fire-and-forget retry pattern (load+0/200/600/1500ms) as the primary delivery mechanism
  - **`onReady()` null guard** — `onReady(fn)` no longer fires callback with `null` user/profile when `_authFailed` is true; callbacks wait for valid auth or the app to reload
- **Login timeout after clearing browsing data** — after clearing browser data and refreshing during a stuck-loading state, login calls could hang indefinitely because the service worker cached Google auth endpoints and Firebase login methods had no timeout
  - **`Auth._authStateResolved` implemented** — `user-system.js` Auth object now sets `_authStateResolved = true` inside `onAuthStateChanged`; previously referenced in `lab-apps.js:157` but never defined (dead code), causing the hub to skip the "auth still loading" guard and redirect to login prematurely
  - **Login timeouts** — `Auth.login()` and `Auth.googleLogin()` now use `Promise.race` with a 15s timeout; surfaces "Login timed out" error instead of hanging forever on "Please wait..." / "Signing in..."
  - **SW: Google auth excluded from cache** — `sw.js` no longer applies stale-while-revalidate to `accounts.google.com` or `apis.google.com`; these are now network-only, preventing stale/corrupt cached auth responses after clearing browsing data
  - **`Auth.offChange(fn)` added** — unsubscribe method for `Auth.onChange` listeners; prevents listener accumulation
  - **Listener cleanup in `wireLabApp()`** — `Auth.onChange` handler and `window.message` listener are stored in module-level refs and removed before re-registration on each `wireLabApp()` call; consolidated message handler sends to whichever iframes are active
- **Null profile silently dropped auth messages** — embedded `auth-bridge.js` handler required `user && profile` to be truthy, but parent sent `profile: null` when Firestore profile hadn't loaded yet; every auth retry was silently ignored, leaving the iframe stuck on "Loading..." indefinitely
  - **Embedded accepts user without profile** — `auth-bridge.js` `_initEmbedded()` now checks `if (user)` instead of `if (user && profile)`; uses `{ role: 'member' }` fallback when profile is null; parent re-sends real profile via `Auth.onChange` when Firestore fetch completes
  - **Parent sends fallback profile** — `lab-apps.js` `buildAuthPayload()` now sends `{ role: 'member' }` fallback when `Auth.currentProfile` is null but user is authenticated
  - **Profile-update path** — `_fireReady()` silently updates `_user`/`_profile` on subsequent calls after initial ready (handles parent re-sending with real profile)
- **Login page redirect loop** — `renderLogin()` didn't check auth state; after apps page timed out and redirected to `#/login`, already-authenticated users saw a login form instead of being redirected to dashboard
  - `renderLogin()` now checks `Auth.currentUser` first and redirects to `#/dashboard` if already authenticated
- `apps/shared/auth-bridge.js` — `_authFailed` flag, `_nullSettleTimer` grace period in `_initStandalone()`, recovery reload in `_fireReady()`, profile-update path in `_fireReady()`, null guard in `onReady()`, `if (user)` check in embedded handler with `{ role: 'member' }` fallback
- `user-system.js` — `Auth._authStateResolved` property, `Auth.offChange()`, 15s `Promise.race` timeout in `Auth.login()` and `Auth.googleLogin()`, `renderLogin()` auth redirect
- `lab-apps.js` — `buildAuthPayload()` fallback profile, `_authChangeHandler` and `_messageHandler` refs with cleanup, consolidated message listener, `Auth.onChange()` forwarding to iframes
- `sw.js` — `accounts.google.com` and `apis.google.com` moved to network-only exclusion block
- `example_app/shared/auth-bridge.js` — synced with main `apps/shared/auth-bridge.js`

## [V3.31] - 2026-04-10

### Added
- **Huddle: Schedule Modes** — color-coded mode selector for "My Schedule" grid
  - **Green (Recurring):** Blocks saved to weekly template, repeat every week on the same day
  - **Blue (Special Date):** One-time availability blocks saved as overrides for a specific date
  - **Red (Blackout):** Non-recurring unavailable time blocks that change week to week
  - Mode selector: three pill-shaped toggle buttons above the schedule grid; active mode changes drag highlight color
  - `showNewScheduleBlockModal()` adapts per mode: green shows full type/reason/rigidity, blue pre-fills available, red pre-fills unavailable
  - Block rendering uses `MODE_COLORS` map (`recurring: #22c55e`, `special: #3b82f6`, `blackout: #ef4444`)
  - New `mode` field on block data model; backward-compatible inference for existing blocks without `mode`
- **Shared Calendar Service** (`apps/shared/calendar-service.js`) — centralized multi-provider calendar integration
  - Exposes `McgheeLab.CalendarService` with `init()`, `getEventsForDate()`, `connectGoogle()`, `connectOutlook()`, `importICSFile()`, `fetchAll()`, `onChange()`
  - Config persisted in Firestore `userSettings/{uid}.calendar`; OAuth tokens session-lived via shared `sessionStorage` keys
  - ICS URL auto-fetch on load; configurable auto-refresh interval (`setInterval`)
  - Loaded via `<script defer>` in huddle, settings, and activity tracker HTML
- **Settings: Calendar Integration** — new section between Notifications and App Administration
  - Provider cards: Google Calendar (OAuth), Outlook/Microsoft 365 (ICS file + OAuth), Apple Calendar (ICS file/URL)
  - Auto-refresh interval dropdown (15m / 30m / 1h / 2h / 4h / disabled)
  - "Sync to Huddle" toggle: auto-block calendar events as blackout times in Huddle schedule
- **Huddle: Calendar → Availability** — `resolveScheduleForUser()` injects calendar events as read-only blackout blocks
  - `parseCalTimeToHHMM()` converts "2:30 PM" → "14:30" for grid positioning
  - Calendar blocks show calendar icon, are non-editable (click shows toast)
  - Only injected for the current user (calendar data is private)

### Changed
- **Activity Tracker** — removed ~620 lines of calendar code; "Calendar" sidebar tab removed
  - Daily view "unlogged events" prompt now sources from `McgheeLab.CalendarService.getEventsForDate()`
  - Calendar configuration moved to Settings page

## [V3.30] - 2026-04-10

### Added
- **Firebase Cloud Functions** (`functions/`) — server-side push notification pipeline completing the existing client-side infrastructure
  - `onChatMessageCreate` — notifies channel subscribers on new chat messages; respects muted channels, mentions-only prefs, and DM routing
  - `onHuddlePlanUpdate` — notifies plan owner when someone joins/watches; notifies joiners+watchers on status change
  - `onHelpRequestCreate` — notifies all lab members when a new help request is posted
  - `onHelpRequestUpdate` — notifies request owner when a new response is added
  - `onEquipmentBookingCreate` — notifies equipment managers when a booking needs approval
  - `onEquipmentBookingUpdate` — notifies booker when booking is confirmed or displaced
  - Core helper `helpers/notify.js`: reads `userSettings/{uid}` for per-app notification toggles, fetches FCM tokens from `users/{uid}/pushTokens`, sends via `messaging.sendEach()`, auto-cleans stale tokens
  - `helpers/users.js`: `sendToAllMembers()` for lab-wide broadcast notifications
- **`firebase.json`** — Firebase deployment config for functions and Firestore rules

## [V3.29] - 2026-04-10

### Added
- **Huddle: The Rundown** — new weekly task list where users post what they plan to do this week
  - Tasks have admin-configurable categories (cell culture, device design, microfluidics, etc.) and optional project association (GELS, ME3B, etc.)
  - Other lab members browse the Rundown feed and request to join tasks (shadow, help) with skill level indicator
  - Task owner sees pending join requests on "My Tasks" tab, can accept/decline
  - Accepting a join request opens a scheduling modal that creates a `huddlePlan` and auto-adds the requester as a joiner
  - New Firestore collections: `huddleRundown`, `huddleConfig/settings`
- **Huddle: Lab Schedule / Availability** — users define their weekly lab schedule
  - Recurring weekly template with per-week overrides for one-off changes
  - Blocks are categorized as Available or Unavailable (with reasons: Class, Study, Analysis, Writing, etc.)
  - Unavailable blocks marked as Rigid (cannot move) or Flexible (could potentially reschedule)
  - Visual encoding: rigid blocks have hatched pattern + lock icon, flexible have dashed border
  - New Firestore collections: `huddleScheduleTemplates/{userId}`, `huddleScheduleOverrides`
- **Huddle: Team Availability** — Gantt-style day view showing all team members' schedules
  - Horizontal time bars per member with color-coded availability/unavailability segments
  - Click a member's row to see schedule overlap toast with free windows
- **Huddle: Availability Overlap Detection** — when scheduling a Rundown task, the modal shows overlapping free windows between owner and requester
  - `resolveScheduleForUser()` merges template + overrides; `resolveAvailabilityOverlap()` computes intersections
- **Huddle: Admin Category Management** — admins can add/edit/remove rundown categories (label + color) from the Settings tab
  - Categories persist lab-wide in `huddleConfig/settings`

### Changed
- **Huddle sidebar** — 5 new tabs: Rundown, Team Availability, Add Task, My Tasks, My Schedule
- **Huddle boot** — subscribes to `huddleRundown`, `huddleConfig`, `huddleScheduleTemplates`, `huddleScheduleOverrides` on startup
- **Huddle week navigation** — re-subscribes rundown and schedule overrides when changing weeks
- **Firestore rules** — 4 new collection rule blocks for rundown, config, templates, overrides

## [V3.28] - 2026-04-10

### Added
- **Settings App** (`apps/settings/`) — unified settings hub in the lab apps bottom nav
  - Profile editing (name, bio), notification preferences (per-app toggles), quiet hours (Do Not Disturb with time range), per-app admin sections, global admin links, sign out
  - New Firestore collection `userSettings/{uid}` for notification prefs and quiet hours

### Changed
- **Lab apps bottom nav** — icon-only on mobile (<=700px), Settings gear icon added to LAB_APPS registry
- **Push service worker** — quiet hours check suppresses notifications during silent periods (badge still increments)
- **Firestore rules** — added `userSettings/{userId}` (owner read/write, admin read)
- **SW precache** — added settings app files

## [V3.27] - 2026-04-10

### Bug Fixes
- **Equipment: Month view day click** — clicking a day in month view now navigates to the correct week (offset calculated from current Monday, not from today)
- **Equipment: Booking refresh** — calendar explicitly re-subscribes and re-renders after booking creation, fixing stale display
- **Equipment: Conflict confirmation** — `checkConflicts()` is now awaited at submit time to prevent race conditions where conflicts weren't detected
- **Chat: Read receipt eyeball** — eyeball icon now only appears on the most recent own message, not all own messages
- **Chat: Notification self-count** — unread badge returns 0 when the last message in a channel is from the current user
- **Chat: Auto-scroll** — added `_isRendering` guard to prevent scroll events during innerHTML replacement from falsely resetting `_autoScroll`
- **Chat: Input box position** — `.chat-main` now uses `overflow: hidden; min-height: 0` and `.chat-feed` uses `min-height: 0` to keep input area fixed at bottom
- **Chat: Thread panel scroll** — added `min-height: 0; overflow: hidden` to `.chat-thread` and `min-height: 0` to `.chat-thread-feed` for proper flex containment
- **Chat: Long history / flashing** — fallback message subscription now caps to `MSG_PAGE_SIZE` most recent messages instead of loading all, reducing DOM thrashing
- **Mobile: Apps oversized** — apps with internal scroll (chat, equipment, huddle) now set `#app` to `overflow: hidden` via `:has()` selector, with child layouts managing their own scroll and bottom-bar padding

### Added
- **Chat: Draft persistence** — unsent message text is saved per-channel to localStorage on typing (debounced 500ms), restored on channel switch, cleared on send
- **Chat: Auto-select recent channel** — on load, auto-selects the most recently active channel instead of defaulting to "general"
- **Chat: Action bar floating** — action bar now floats above the selected message as a positioned overlay (rounded, shadowed) instead of being a static bar above the input area
- **Chat: Pinned messages inline panel** — pinned messages now appear as a collapsible inline panel between the header and feed, replacing the modal overlay
- **Chat: Bold edited channels** — sidebar channels with unread edits (`lastMessage.editedAt > lastReadAt`) are displayed in bold italic
- **Equipment: Multi-day drag scheduling** — drag-to-select on the week calendar now supports dragging across multiple day columns
- **Huddle: Drag-to-create** — pointer-based drag on empty time grid cells creates a time selection and opens the add plan form pre-filled with the selected day and time range

## [V3.26] - 2026-04-10

### Added
- **Multi-day equipment bookings** — bookings can now span multiple days with independent start/end dates and times
  - **Booking modal** restructured with "Start Date / Start Time" and "End Date / End Time" rows; end date auto-advances when start date moves past it
  - **Week view segments** — multi-day bookings render a block per visible day (first day: startTime→end of day, middle days: all day, last day: start of day→endTime)
  - **Month view** — multi-day bookings show dots on every day they span, not just the start date
  - **Booking detail popup** — shows start and end date/time on separate lines with a "multi-day" badge when dates differ; duration displayed in days+hours format
  - **My Bookings** — date range shown for multi-day bookings; upcoming filter uses end date so active multi-day bookings stay visible
  - **Conflict checking** updated to detect overlaps across the full date range of both new and existing bookings
  - **Google Calendar sync** — events use correct start date/time and end date/time for proper multi-day display
  - **Subscription query** widened by 30 days to catch multi-day bookings that started before the current view window
  - **Data model**: new `endDate` field on bookings; backward compatible — legacy single-day bookings default `endDate` to `date`
- **Calendar freeze-pane layout** — toolbar, legend, and day headers stay fixed while the time grid scrolls independently
  - **Flex layout** — `.eq-layout` fills available viewport height; `#eq-content` flexes to fill remaining space; `eq-cal-header` (toolbar + legend) is flex-shrink: 0; `eq-cal-body` fills the rest with `overflow: hidden`
  - **Sticky day headers** — corner cell + day name cells use `position: sticky; top: 0; z-index: 3` inside `.eq-week-wrap` scroll container, so they stay visible while scrolling through time slots
  - **Scroll wrapper** — `.eq-week-wrap` is the sole vertical scroll container; `height: 100%` fills the body; native scrollbar hidden
  - **Auto-scroll to 8 AM** on first render so the most-used working hours are immediately visible
  - **Scroll position preserved** across re-renders (zoom, booking updates) with proportional scaling when zoom level changes
- **Custom time slider** — replaces native scrollbar and mobile-shell time-scroll handle
  - **Positioned alongside the grid** — sits to the right of `.eq-week-wrap` inside `.eq-cal-scroll-area` flex row; spans only the time-based part of the calendar, not the toolbar or day headers
  - **Proportional thumb** — thumb height = `(clientHeight / scrollHeight) * trackHeight`; scales with zoom level (larger when zoomed out, smaller when zoomed in); auto-hides when all content fits on screen
  - **Interactive** — drag thumb or click track to scroll; supports both touch and mouse; styled with accent color, rounded corners, hover/active opacity
  - **Replaces mobile-shell slider** — `disableTimeScroll()` called on render; custom slider works identically on desktop and mobile
- **Calendar time-scale zoom** — adjust time slot density to see the full day or zoom into specific hours
  - **Zoom buttons** (+/−) positioned in the legend row, right-aligned above the Sunday column; 9 zoom levels from 4px to 76px per half-hour slot
  - **Full-day fit** — at minimum zoom (4px/slot), the entire 24-hour day is ~192px tall, fitting on any screen without scrolling
  - **Pinch-to-zoom** on touch devices via two-finger gesture on the week grid; ratio thresholds at 0.5/0.7/1.3/1.7 for ±1 or ±2 level jumps
  - **Zoom-aware rendering** — `grid-template-rows` uses `${slotH}px` instead of `1fr`, giving precise control over row height
- **Huddle calendar parity** — the Huddle time grid now has all the same calendar features as the Equipment Scheduler
  - **Freeze-pane layout** — `.hud-cal-layout` flex column with `.hud-cal-header` (nav, filters, zoom) pinned at top; `.hud-cal-body` fills remaining space; day headers sticky within `.hud-grid-wrap` scroll container
  - **Custom time slider** — `.hud-time-slider` alongside the grid with proportional thumb; auto-hides when fully zoomed out; replaces mobile-shell time-scroll
  - **Time-scale zoom** — +/− buttons in legend row; 9 zoom levels (4px–76px per slot); pinch-to-zoom on touch; full-day fit at minimum zoom
  - **Phone-width scaling** — grid `min-width` removed on mobile; columns use `36px repeat(7, 1fr)` to fill phone width without horizontal scroll; font sizes scaled down for day headers, time labels, and plan blocks
  - Applied to Plan Feed (weekly), My Plans daily, and My Plans weekly views; monthly view unchanged
  - View toggle included in cal-header for day/week views so it stays fixed with the toolbar

## [V3.25] - 2026-04-10

### Added
- **Desktop split-view** — two lab apps can be open side-by-side with a draggable divider
  - **Split button** in bottom nav bar toggles split mode; first non-active app auto-fills second pane
  - **Draggable divider** — vertical bar between panes; drag to resize from 20% to 80%; double-click to reset 50/50; grip indicator highlights on hover in accent blue
  - **Bottom nav interaction** — clicking an inactive app while in split opens it in second pane; clicking the split-highlighted app makes it primary; split-pane app shown in green highlight
  - **Close split** — X button on right pane (appears on hover), split toggle, or clicking the active primary app
  - **Auth bridging** — both iframes receive auth credentials independently on load
  - **Mobile excluded** — split view hidden at ≤700px; always single-pane on phones
- **Full-viewport app layout** — embedded apps fill from banner to bottom nav via flex pane container; `#app` uses `overflow: auto` so app layouts scroll naturally at full width
- **Hand preference setting** — left/right hand toggle stored in localStorage (`mcgheelab-hand-preference`); accessible in hamburger menu on all apps; sets `data-hand` attribute on body for CSS to respond; affects sidebar direction in chat, time-scroll handle position, and edge tab position
- **Calendar time-scale scroll handle** — vertical draggable strip on screen edge (hand-aware side) for scrolling calendar grids without scrolling the page; thumb syncs with grid scroll position; supports touch and mouse; activated via `MobileShell.enableTimeScroll(element)`; integrated with equipment scheduler week grid
- **Chat mobile sidebar edge tab** — small pull-out handle on the screen edge (hand-aware side) visible in conversation view; tapping opens the full channel/DM sidebar; sidebar slides in from left (right-handed) or right (left-handed)
- **Bottom nav content overlap fix** — `--bottom-bar-h` CSS variable in `:root` = `calc(48px + env(safe-area-inset-bottom))`; `#app` gets `padding-bottom: var(--bottom-bar-h)` on mobile; chat layout uses same variable; prevents buttons and content from hiding behind fixed bottom navigation
- **Mobile swipe navigation** — swipe left/right on any lab app navigates to the next/previous app in the tab order (Chat → Meetings → Equipment → Activity → Huddle, wraps around); requires quick horizontal gesture (>80px, <300ms); implemented in both `mobile-shell.js` and chat's own gesture handler
- **Pull-to-refresh prevention** — `overscroll-behavior: none` on html and body in `app-base.css` and set via JS; `overflow-x: hidden` prevents horizontal page bounce; top and bottom navigation bars are fixed and don't respond to swipe gestures
- **Standalone auth reliability** — `auth-bridge.js` `_initStandalone()` now polls for Firebase SDK availability (200ms intervals, max 8s) instead of failing immediately when SDK hasn't loaded; uses `firebase.auth()` directly rather than depending on `McgheeLab.auth` being pre-initialized; prevents false auth-wall when navigating between standalone apps
- **Mobile-first lab app redesign** — all lab apps now have a phone-optimized layout
  - **Shared mobile shell** (`apps/shared/mobile-shell.js`) — reusable top bar (title + user icon + hamburger menu) and bottom bar (lab app quick-nav icons + back arrow) injected on screens ≤700px; hamburger opens slide-in menu with links to all lab apps; bottom bar provides one-tap switching between Chat, Meetings, Equipment, Activity, and Huddle
  - **`app-base.css` mobile shell styles** — `.mobile-top-bar` with filter/title/user layout, `.mobile-bottom-bar` with app nav icons and floating back button, `.mobile-hamburger-menu` slide-in overlay, `.mobile-filter-btn` and `.mobile-filter-dropdown` for sort controls, `.mobile-user-btn` avatar circle, `.mobile-back-btn` accent-colored FAB; all hidden on desktop via `@media (max-width: 700px)` gate; desktop `.app-header` hidden on mobile
  - **Chat conversation list view** — mobile landing page shows all subscribed channels and DMs as a flat scrollable list with channel icon, name, last message preview, timestamp, and unread/mention badges; replaces desktop sidebar on phone screens
  - **Chat conversation filter** — top-left dropdown with 4 sort modes: Newest, Most Active, Unread First, A–Z; persists during session
  - **Chat mobile stats bar** — centered bar between header and feed showing reader count (eyeball icon), search shortcut, and file count with tap-to-open actions
  - **Chat files-in-conversation view** — full-screen file browser showing all attachments in the current channel grouped by type (Images, Documents, Other) with file name, author, timestamp, and size; accessible via stats bar file icon
  - **Chat mobile view state machine** — `_mobileView` state ('list' | 'conversation' | 'files') with CSS class toggles (`chat-layout--mobile-list`, `chat-layout--mobile-conv`, `chat-layout--mobile-files`) controlling visibility of sidebar, conversation list, main feed, and files view
  - **Chat mobile hamburger menu** — slide-in from right with Browse Channels, New DM, Manage Contacts, Search Messages, Settings (admin), and All Lab Apps links
  - **Mobile back-arrow navigation** — accent-colored floating button at bottom-right on all sub-pages (conversation, files, threads); tapping navigates back through view stack (files → conversation → list)
  - **Bottom bar app quick-nav** — horizontal scrollable row of 5 app icons (Chat, Meetings, Equipment, Activity, Huddle) with labels; active app highlighted; links navigate to sibling app `index.html`

### Changed
- **No double navigation on mobile** — parent page's top banner, bottom tabs, and desktop bottom nav all hidden on phone screens (≤700px) when inside an embedded lab app; iframe's own mobile-shell handles all navigation; `body.apps-env` hides bottom-tabs on hub page; `body.apps-embedded` hides top-banner on mobile; `.lab-app-bottom-nav` hidden at ≤700px via CSS
- **Install banner redesigned** — compact single-row layout (28px icon, smaller text/buttons); device-specific install instructions: iPhone/iPad in non-Safari browsers told to open Safari first; iOS Safari users see share icon + "Add to Home Screen"; Samsung Browser users see menu instructions; Android Chrome/Edge get native Install button; desktop Safari shows File → Add to Dock; other desktop browsers get Install button
- `app.js` — `getInstallBannerHTML()` rewritten with full device detection (iPhone, iPad, Android, Samsung Browser, Firefox, Safari desktop, Chrome/Edge); generates device-appropriate instruction text with inline SVG icons; `body.apps-env` and `body.apps-embedded` classes toggled on route change for CSS hooks
- `styles.css` — `.pwa-install-banner` reduced from 14px/16px padding to 8px/10px; icon shrunk from 44px to 28px; `.pwa-install-content` wrapper removed (flat flex layout); `.pwa-install-text` replaces nested `<div><strong>...<p>` structure; `.pwa-install-btn` padding reduced; added `body.apps-env .bottom-tabs` and `body.apps-embedded .top-banner` mobile hide rules
- `user-styles.css` — added `@media (max-width: 700px)` rule hiding `.lab-app-bottom-nav` and setting `.lab-apps-page--embedded { top: 0 }` to fill full viewport when top banner hidden
- `apps/shared/app-base.css` — removed `body { padding-bottom: 56px }` and `#app { padding: 1rem .75rem }` mobile overrides (app layouts handle their own spacing internally)
- `app.js` — lab apps environment (`#/apps` and `#/apps/{appId}`) now hides both hero and site footer on all platforms; `isAppsEnv` flag added alongside existing `hideHero` logic; footer restored when navigating to any non-apps page
- `lab-apps.js` — `renderLabApp()` replaced breadcrumb navigation with bottom nav bar; bottom bar shows all active apps as horizontal scrollable links with icons + labels; active app highlighted; iframe no longer auto-resized via postMessage (CSS flex layout handles sizing)
- `user-styles.css` — `.lab-apps-page--embedded` now uses `position: fixed` filling from banner bottom to viewport bottom; removed breadcrumb styles; added `.lab-app-bottom-nav` with horizontal scrollable app links, blur backdrop, accent highlight for active app; `.lab-app-iframe-wrap` and `.lab-app-iframe` fill parent via flex; mobile breakpoint stacks bottom nav items vertically
- `apps/shared/app-base.css` — both `body.app-embedded` and `body.app-standalone` now use `height: 100vh; overflow: hidden; display: flex; flex-direction: column` for viewport-filling layouts; `#app` becomes flex child filling remaining space; `#app > *` gets `flex: 1; min-height: 0` so app layouts stretch to fill; added mobile shell component styles (top bar, bottom bar, hamburger menu, filter dropdown, user button, back button); desktop app-header hidden at ≤700px breakpoint
- `apps/chat/styles.css` — embedded layout height changed from fixed 700px to 100vh
- `apps/chat/styles.css` — added `.chat-conv-list`, `.chat-conv-item`, `.chat-conv-icon`, `.chat-conv-badge`, `.chat-mobile-stats`, `.chat-stat-item`, `.chat-files-view`, `.chat-files-group`, `.chat-files-item` component styles; added mobile view state classes (`chat-layout--mobile-list/conv/files`) in 700px media query
- `apps/chat/app.js` — added mobile state variables (`_mobileView`, `_conversationFilter`, `_mobileFilterOpen`, `_mobileHamburgerOpen`, `_mobileNavStack`); added `isMobile()`, `getMobileViewClass()`, `getFilteredConversations()`, `renderMobileConversationListHTML()`, `renderMobileTopBarHTML()`, `renderMobileStatsBarHTML()`, `renderMobileFilesViewHTML()`, `renderMobileBottomBarHTML()`, `renderMobileHamburgerMenuHTML()`, `mobileGoBack()`, `wireMobile()` functions; added `svgFilter()`, `svgBackArrow()`, `svgChat()`, `svgPeople()`, `svgCalendar()`, `svgChart()`, `svgHuddle()` SVG icons; `render()` now includes mobile top bar, conversation list, stats bar, files view, bottom bar, and hamburger menu; `selectChannel()` switches to conversation view on mobile; `wireAll()` calls `wireMobile()`
- `apps/activity-tracker/app.js` — added `MobileShell.configure()` call with appId and title
- `apps/meetings/app.js` — added `MobileShell.configure()` call with appId and title
- `apps/equipment/app.js` — added `MobileShell.configure()` call with appId and title
- `apps/huddle/app.js` — added `MobileShell.configure()` call with appId and title
- `apps/scheduler/app.js` — added `MobileShell.configure()` call with appId and title
- `apps/activity-tracker/index.html`, `apps/meetings/index.html`, `apps/equipment/index.html`, `apps/huddle/index.html`, `apps/scheduler/index.html` — added `<script defer src="../shared/mobile-shell.js">` before app.js

## [V3.25] - 2026-04-10

### Changed
- **Push Notification Enhancements** — upgraded push system for full native-like experience
  - **Vibration** — `vibrate: [200, 100, 200]` pattern on background notifications (Android)
  - **Desktop persistence** — `requireInteraction: true` keeps notifications in system tray until dismissed (desktop Chrome/Edge)
  - **Notification tagging** — `tag` field for grouping; unique by default (notifications stack), server can set `tag: 'chat-{channelId}'` to group/replace
  - **App icon badge counts** — Badging API increments count on background push, clears when user opens app or clicks notification; IndexedDB-backed counter shared between service worker and main thread (Android Chrome PWA + desktop Chrome/Edge; not supported on iOS)
  - **Proactive permission prompt** — native browser permission dialog fires automatically on first standalone PWA launch after auth resolves (1.5s delay); `localStorage` flag prevents re-prompting; non-standalone visitors still see passive banner on apps hub
  - **Badge clearing** — `visibilitychange` and `focus` listeners clear app badge when user returns to app; also clears on `notificationclick` in service worker
  - **Badge management API** — `McgheePush.setBadge(count)`, `McgheePush.clearBadge()`, `McgheePush.isBadgingSupported()` added to push-notifications.js

## [V3.24] - 2026-04-10

### Added
- **Progressive Web App (PWA)** — site is now installable on iPhone and Android as a standalone app
  - **Web App Manifest** (`manifest.json`) — app name, icons, shortcuts to Activity Tracker, Lab Chat, Equipment Scheduler, and The Huddle; `start_url: /#/apps`; `display: standalone`
  - **Service Worker** (`sw.js`) — precaches shell (index.html, app.js, styles, all core JS) and all 8 lab app files; stale-while-revalidate for shell, cache-first for images, network-first for CDN (Firebase SDK), network-only for Firebase API calls; versioned caches for clean updates
  - **App Icons** (`icons/`) — 13 icon sizes generated from Mlab.png: 72, 96, 128, 144, 152, 192, 384, 512px standard + 512px maskable + 180px apple-touch-icon + 32/16px favicons + favicon.ico
  - **iOS PWA Support** — `apple-mobile-web-app-capable`, `apple-mobile-web-app-status-bar-style: black-translucent`, `apple-mobile-web-app-title`, `apple-touch-icon`
  - **Install Prompt UI** — on apps hub page: Android/Chrome shows "Install" button via `beforeinstallprompt`; iOS shows "Add to Home Screen" instructions with Share icon
  - **SW Update Notification** — toast banner when new version available with "Refresh" action
  - **Standalone Mode CSS** — `@media (display-mode: standalone)` rules for safe-area padding on banner and hero; toast positioned above safe area in standalone
- **Push Notifications** (Firebase Cloud Messaging)
  - **FCM Service Worker** (`firebase-messaging-sw.js`) — handles background push notifications; shows system notification with app icon; click navigates to relevant page
  - **Client Module** (`push-notifications.js`) — `McgheePush.init()`, `requestPermission(userId)`, `removeToken(userId)`, `onForegroundMessage(callback)`, `isSupported()`, `getPermissionState()`
  - **Permission Prompt** — shown on lab apps hub, contextual (not on page load); "Turn on" button calls `McgheePush.requestPermission()`
  - **Foreground Toast** — in-app toast for push messages received while app is open
  - **FCM Token Storage** — tokens saved to Firestore `users/{userId}/pushTokens/{token}` with platform detection (ios/android/desktop)
  - **FCM SDK** — `firebase-messaging-compat.js` added to index.html script tags
  - **Firestore Rules** — `pushTokens` subcollection: owner read/write only
- **Offline Fallback** — auth-bridge.js detects `navigator.onLine`; shows "You're offline" wall with retry button and auto-reload on reconnection
- **PWA Meta Tags** on all 8 app `index.html` files — `theme-color`, `apple-mobile-web-app-capable`, `apple-touch-icon`, `favicon`

### Changed
- `index.html` — added manifest link, theme-color, iOS PWA meta, Microsoft Tile meta, favicon links, FCM SDK script, push-notifications.js script, service worker registration script
- `app.js` — added `setupPWA()` in bootstrap; `getInstallBannerHTML()`, `getNotificationPromptHTML()`, `showToast()`, `showUpdateToast()`, `showPushToast()` functions; `mcgheeInstallPWA()` and `mcgheeRequestPush()` globals
- `lab-apps.js` — `renderLabApps()` now includes install banner and notification prompt HTML above the app grid
- `styles.css` — added section 15: PWA install banner, notification prompt, toast, standalone mode, animations
- `apps/shared/auth-bridge.js` — `_fireAuthFailed()` now checks `navigator.onLine` before showing auth wall; auto-retries on reconnect
- `firestore.rules` — added `pushTokens` subcollection match under `users/{userId}`

## [V3.23] - 2026-04-09

### Added
- **Lab Chat App** — real-time messaging app at `apps/chat/` integrated into the lab apps ecosystem
  - **Channel system** — topic-based channels with admin-defined categories (General, Projects, Courses, Lab Operations, Social); anyone can create channels; each channel assigned to a category
  - **Subscription model** — all channels visible/browseable; users subscribe to channels they want notifications for; channel directory modal grouped by category with subscribe/unsubscribe buttons
  - **Custom sidebar organization** — users create named groups and drag channels between them; group names are editable; subscribed channels shown in user-defined layout
  - **Real-time messaging** — Firestore `onSnapshot` listeners for live message updates; limit 50 per channel; message pagination on scroll (load older via `.get()`)
  - **Threaded replies** — "Reply in thread" slide-out panel with dedicated input; thread indicator on parent messages showing reply count and last reply time
  - **Direct messages** — 1:1 conversations via user picker modal; DMs listed in dedicated sidebar section
  - **Reactions** — 20 fixed emoji set (thumbs up, heart, fire, check, etc.); emoji picker on hover; toggle on/off; reaction counts
  - **@mentions** — `@user` and `@channel` with autocomplete popup; keyboard navigation (arrow keys + Enter/Tab); mention highlighting in rendered messages; mention badge counts in sidebar
  - **Read receipts** — per-message `readBy` array updated via `arrayUnion` batch; small avatar row (max 5 + overflow) under messages; click for "Seen by" modal
  - **Message edit/delete** — authors edit own messages (inline textarea); soft delete shows "message deleted" placeholder; admins can delete any message; "(edited)" indicator
  - **Pinned messages** — pin/unpin action; pinned badge on messages; "View Pinned" modal from channel header
  - **Google Drive file sharing** — OAuth via Google Identity Services (same pattern as Equipment Scheduler); uploads to shared lab Drive folder with auto-created channel subfolders; "anyone with link" permission; inline image thumbnails for images; file cards for non-images
  - **Drag-and-drop & clipboard paste** — drag files onto feed or input area; paste images from clipboard
  - **Simple markdown** — `*bold*`, `_italic_`, backtick code, triple-backtick code blocks, auto-linked URLs
  - **Client-side search** — search overlay filtering loaded messages by text content, author name, or file name
  - **Browser notifications** — permission request on load; notifications for @mentions and DMs when tab is unfocused
  - **Auto-scroll** — scrolls to bottom on new messages only if user is near bottom; "New messages" floating button when scrolled up
  - **Mobile responsive** — hamburger sidebar drawer, fullscreen thread overlay, touch-friendly action buttons
  - **Admin settings** — manage channel categories; configure Google Drive OAuth Client ID and shared folder ID
  - **Default channels** — #general, #announcements (admin-post-only), #random auto-created on first boot
  - **Firestore collections:** `chatConfig/settings` (categories, Drive config), `chatChannels/{channelId}` (channel metadata with denormalized lastMessage), `chatMessages/{messageId}` (messages with reactions map, readBy array, thread fields), `chatReadState/{uid_channelId}` (per-user-channel read tracking), `chatUserMeta/{uid}` (subscriptions, sidebar layout, notification prefs)
  - **Security rules:** authenticated read on all chat collections; author-only message create with uid check; authenticated update on messages (for reactions/read receipts); admin-only delete on channels; owner-only chatUserMeta
  - Registered in `LAB_APPS` with `status: 'active'`; follows standard app patterns: `auth-bridge.js`, `app-base.css`, `chat-` CSS prefix, three-panel layout, real-time Firestore listeners

## [V3.22] - 2026-04-09

### Added
- **Equipment Scheduler Lab App** — full equipment booking system at `apps/equipment/` for scheduling shared lab instruments
  - **Weekly calendar view** — CSS Grid layout with 30-min time slots (7am–9pm), booking blocks positioned by grid-row/column with priority-colored left borders and tinted backgrounds; click empty cells to create bookings; click blocks for detail popups
  - **Monthly calendar view** — 7-column grid with colored booking dots per day; click any day to jump to that week's view
  - **Per-device filtering** — dropdown selector to view all equipment or a single device's calendar; real-time Firestore `onSnapshot()` listener re-queries on filter change
  - **Priority color coding** — four levels (normal/blue, high/yellow, urgent/red, maintenance/gray) with customizable colors in admin settings; legend bar below toolbar
  - **Booking flow** — modal form with equipment selector, date/time pickers, priority, notes; real-time conflict detection queries existing bookings for overlaps; duration min/max and advance-day constraints enforced from device config
  - **Training & permission system** — admin defines certification types in settings; assigns certifications per user via checkbox table; each device can require specific certifications; `canUserBook()` checks category restrictions, certifications, and co-operator requirements
  - **Co-operator requirement** — devices can require undergrads (or users below a configurable category threshold) to select a grad+ co-operator from the users list; co-operator name stored on booking and included in Google Calendar events
  - **Admin: Manage Equipment** — CRUD for device catalog with name, shortName, location, category, status, booking constraints (min/max duration, advance days, available hours), training/access config, and Google Calendar ID
  - **Admin: Training Management** — table of all lab members with checkbox columns per certification; grant/revoke updates Firestore `equipmentTraining/{uid}` docs
  - **Admin: Settings** — Google Calendar OAuth Client ID, connect/disconnect, per-device calendar ID, certification definitions (add/edit/remove), priority color customization, "Sync All" bulk sync button
  - **Google Calendar sync** — admin-driven push via Google Identity Services OAuth (`calendar.events` scope); creates/updates/deletes Google Calendar events when bookings change; per-device `gcalCalendarId` for separate calendars per instrument; session-lived token in `sessionStorage`
  - **My Bookings tab** — user's own bookings list (upcoming + past/cancelled) with status badges and click-to-detail
  - **Firestore collections:** `equipment/{equipmentId}` (device catalog), `equipmentBookings/{bookingId}` (reservations with denormalized names), `equipmentTraining/{uid}` (per-user certifications), `equipmentSettings/config` (global config singleton)
  - **Security rules:** authenticated read on all 4 collections; admin-only write on equipment/training/settings; booking create for any auth user, update/delete for owner or admin
  - Registered in `LAB_APPS` with `status: 'active'`; follows standard app patterns: `auth-bridge.js`, `app-base.css`, `eq-` CSS prefix, tab layout, real-time Firestore listeners

## [V3.21] - 2026-04-09

### Added
- **Lab Meeting App** — fully functional lab app at `apps/meetings/` for managing weekly lab meetings
  - **Next Meeting view** — default landing showing upcoming meeting with presenter, agenda, notes, carry-over action items, and post-presentation reaction chips
  - **Manual presenter assignment** — admin assigns 1 or 2 presenters per meeting via dropdown (in Schedule view or Next Meeting view); meetings generate with TBD presenters; supports `presenters[]` array
  - **Collaborative agenda builder** — any authenticated member can add business/announcement/discussion items to the next meeting; admin can reorder and remove; presentation slot auto-populated from rotation
  - **Action item tracking** — assign tasks with deadlines to any lab member during meetings; open items from previous meeting surface on Upcoming view; toggle done/open; "My Items" personal view with overdue highlighting
  - **Meeting notes archive** — shared notes field per meeting; completed meetings searchable by presenter, title, or notes content; expandable archive cards with full details
  - **Cross-pollination signals** — after presentations, members can leave reaction chips: "Interesting", "I have questions", "Want to collaborate", "Relevant to my work"; presenter sees summary; reactions persist in archive
  - **Presentation materials** — presenter (or admin) can attach labeled links (slides, papers, datasets) that persist in the archive
  - **Postpone meetings** — admin can postpone an upcoming meeting to a new date via calendar picker modal (alongside Complete and Cancel actions)
  - **Skip weeks** — skip entire weeks instead of individual dates; pick any date in a week to skip; stored as week-start (Monday) dates
  - **Calendar date pickers** — semester start/end and skip-week inputs use custom mini-calendar popout with month navigation, today highlight, and selected-date highlight
  - **Settings view** — admin configures meeting day/time/duration/location, semester dates, and skip weeks; non-admin sees read-only summary
  - **Firestore collections:** `meetings/{meetingId}` (embedded presenters[], agendaItems[], actionItems[], feedback[] arrays), `meetingConfig/settings` (semester config, skip weeks)
  - **Security rules:** authenticated read/create/update on meetings; admin-only delete; admin-only write on meetingConfig
  - Registered in `LAB_APPS` with `status: 'active'`; follows standard app patterns: `auth-bridge.js`, `app-base.css`, `mtg-` CSS prefix, sidebar+main layout, real-time Firestore listeners

## [V3.20] - 2026-04-09

### Added
- **Guest Instructions & Progress** — guests see admin-written (or auto-generated) instructions in the welcome block; progress pills show green (done) / grey (pending) status for each required task (Availability, Summary, Questions, Materials)
- **Admin Custom Instructions** — new `guestInstructions` textarea in Schedule Settings; defaults auto-generated per enabled guest fields and mode; "Reset to Default" button regenerates from current settings
- **Admin Edit Title/Description** — title and description fields added to Schedule Settings form; saved alongside schedule config via `onSaveSchedule` callback
- **Guest Names on Admin Grid** — sessions grid shows first names of available guests in each unassigned slot (up to 3 + overflow count); freeform grid shows full name list as hover tooltip; replaces bare availability counts

## [V3.19] - 2026-04-09

### Added
- **Scheduler Lab App** — moved scheduler from dashboard into standalone lab app at `apps/scheduler/`
  - **List view** — shows all user-owned schedulers with manage/delete actions; create form for new schedulers with title, description, and mode selection
  - **Editor view** — full admin scheduler editor using `McgheeLab.Scheduler` engine; view switcher (Admin/Guest/Public), guest management, session builder, freeform availability, auto-assign optimization
  - **Self-contained ScheduleDB** — Firestore CRUD for `schedules` and `participants` collections inline in app.js; no dependency on `class-builder.js`
  - **Invite URL generation** — builds invite links pointing to main site's `#/schedule/{id}?key={key}` route
  - Loads `scheduler.js` engine via `<script>` tag for full calendar, time grid, and builder functionality
  - Registered in `LAB_APPS` array in `lab-apps.js` with `status: 'active'`
  - Follows standard lab app patterns: `auth-bridge.js` for dual-mode auth, `app-base.css` for theming, embedded resize notifications

## [V3.18] - 2026-04-09

### Added
- **Learning Modules** — standalone HTML lesson pages viewable within the SPA with auto-navigating class headers; any HTML file from any folder can be added to any class
  - **SPA iframe viewer** — `#/classes/{classId}/modules/{filename}` route renders nav header + iframe; `renderModuleViewer()` / `wireModuleViewer()` in `class-builder.js`; iframe `src` resolved from module's `folder` field; routing added to `app.js`; standalone HTML files require zero modifications
  - **Module nav bar** — back-to-class link, lesson progress ("Lesson 2 of 8"), module title, prev/next navigation, homework download; Firestore-driven from `schedules/{classId}.modules[]`
  - **Module manifest** (`modules/manifest.json`) — auto-generated index of all HTML files in `modules/` organized by folder; `scripts/scan_modules.py` walks directories, extracts `<title>` tags, writes JSON
  - **"Learning Modules" section type** in class builder — `SECTION_REG` entry with `component: 'modules'`; admin card list with reorder/publish/delete; public numbered link list
  - **Add Module modal** — `openAddModuleModal()` fetches manifest; folder-organized dropdown + live search across all module files; auto-fills lesson title from HTML `<title>` tag; modules from any folder can be added to any class
  - **File picker component** — reusable `openFilePicker()` with grouped list, search filtering, data-attribute indexing; used by both module and homework pickers
  - **Homework picker modal** — `openHomeworkPicker()` uses same file picker pattern to search/browse uploaded assignment files (from `classFiles` with `hasDue` sections)
  - **Module data model** — `modules[]` array on `schedules/{classId}` doc; each entry: `{ id, title, htmlFile, folder, order, homeworkFileId, published }`
  - **Standalone fallback header** (`modules/shared/module-header.js` + `module-header.css`) — for direct file access; auto-skips when inside iframe
  - **Module template** (`modules/_template.html`) — starter HTML file with dark-theme lesson content styles

## [V3.17] - 2026-04-09

### Added
- **The Huddle** — new lab app at `apps/huddle/` for community-driven weekly planning
  - **Weekly Plan Board** — week-at-a-glance feed showing all lab members' planned tasks, grouped by day (Mon-Fri) with real-time updates via Firestore `onSnapshot`
  - **Watch/Join sign-ups** — any lab member can click "Watch" (observe) or "Join" (participate) on another member's task; uses Firestore `arrayUnion`/`arrayRemove` for concurrent sign-ups; participants shown as pills on plan cards
  - **Protocol Linking** — attach a protocol (title + URL) to any plan; renders as clickable chip for watchers to pre-read
  - **Weekly Check-in Prompt** — guided prompt on empty weeks: "What protocols are you running?", "Anything blocking you?", "Need help with anything?"; auto-parses comma/newline-separated plans into individual plan docs
  - **My Plans view** — personal plan management with add/edit/delete, mark as completed/skipped
  - **Status management** — plans can be marked cancelled (with strikethrough + reason), delayed (auto-copies to target week), or skipped; visual indicators (border colors, opacity, badges) communicate status to watchers
  - **Delete confirmation modal** — prevents accidental plan deletion
  - **Status update modal** — cancel/delay/skip with optional reason; delayed plans auto-create a copy in the selected future week
  - **Week navigation** — prev/next/today buttons with dynamic week labels
  - **Sidebar navigation** — Lab Feed and My Plans sections
  - **Real-time collaboration** — `onSnapshot` listener on `huddlePlans` collection, filtered by ISO week ID; all changes from any lab member appear instantly
  - Firestore collections: `huddlePlans` (plans with embedded watchers/joiners arrays), `huddleCheckins` (weekly check-in responses), `huddleProtocols` (shared protocol library, Phase 2)
  - Security rules added to `firestore.rules` for all three collections
  - Registered in `LAB_APPS` array in `lab-apps.js` with `status: 'active'`

## [V3.16] - 2026-03-31

### Added
- **Activity Tracker** — new standalone lab app at `apps/activity-tracker/` for daily activity logging
  - **Hierarchical category taxonomy** — 5 top-level categories (Research, Coursework, Service, Professional Development, Administration) with 30+ subcategories; users can add custom categories at any level
  - **Daily view** — date navigation, text input with duration auto-parsing ("90m", "1.5h"), task list with inline category assignment, daily summary chips by category
  - **ML categorization** — Multinomial Naive Bayes text classifier (vanilla JS, no dependencies); trains incrementally on every manual categorization; suggests top-3 categories after ~20 training examples; "ML Categorize" button for batch assignment
  - **AI categorization** — Anthropic API integration (per-user API key from profile); "AI Categorize" button sends uncategorized tasks to Claude; human approval UI (accept/reject per suggestion); approved results further train ML model
  - **Voice input** — Web Speech API microphone button (Chrome/Edge); appends recognized text to input
  - **Milestone stars** — 1-5 star rating per task for annual review aggregation (not importance); milestone timeline in analytics
  - **Duration tracking** — auto-parsed from natural language in task text; manual inline input; summary totals per category
  - **Weekly view** — 7-day grid with task previews, color-coded by top-level category, weekly totals
  - **Analytics dashboard** — Chart.js charts: time distribution (doughnut), daily trend (line), category breakdown (horizontal bar), milestone list; metrics: total time, days logged, avg/day, total tasks, milestones, categories used
  - **AI insights** — "Get AI Insights" button sends 30-day summary to Claude for efficiency suggestions
  - **Category manager** — tree view UI for adding/removing subcategories; color-coded dots
  - **Multi-provider calendar integration** — three calendar providers supported simultaneously:
    - **Google Calendar** — OAuth2 via Google Identity Services; user provides their own OAuth Client ID
    - **Outlook / Microsoft 365** — OAuth2 via MSAL (Microsoft Authentication Library); user provides Azure App (Client) ID; fetches events from Microsoft Graph API (`/me/calendarview`)
    - **Apple Calendar (ICS)** — import `.ics` files directly or fetch from a public iCloud calendar URL (via CORS proxy); minimal VEVENT parser extracts SUMMARY, DTSTART, DTEND, UID
    - Events from all providers are merged, sorted by start time, and shown with color-coded provider dots (blue=Google, blue=Outlook, gray=ICS)
    - Import per event or "Import All Unlogged" batch; unlogged event prompts in daily view; auto-detects token expiry per provider
  - **Settings** — API key status indicator, ML model training status/reset, working hours, Google Calendar client ID, JSON data export
  - **Bulk paste mode** — toggle between "Single Task" and "Bulk Paste" input modes; textarea for pasting a full paragraph of the day's activities; three parse options:
    - "Split & Add" — sentence splitter (period/newline/semicolon boundaries) with auto duration parsing, adds as uncategorized
    - "Split & ML Categorize" — splits + runs Naive Bayes on each task for automatic categorization
    - "AI Parse & Categorize" — sends entire paragraph to Claude which returns structured tasks with categories and durations; results shown in approval overlay for accept/reject per task
  - **Privacy** — strictly owner-only Firestore rules (no admin read access); `trackerData/{userId}` for settings/categories/ML model; `trackerEntries/{userId}/entries/{entryId}` subcollection for entries
  - Registered in `LAB_APPS` array in `lab-apps.js` with `status: 'active'`
- **Dashboard API Keys card** — centralized Anthropic API key management on the main dashboard (`#/dashboard`)
  - Save/Clear buttons with inline status feedback
  - Key stored in user profile (`anthropicKey` field) — accessible to all apps (CV Builder, Activity Tracker, etc.)
  - Hint linking to `console.anthropic.com` for key creation
  - Previously only configurable through CV Builder settings

## [V3.15] - 2026-03-24

### Changed
<<<<<<< Updated upstream
- **Grouped navigation redesign** — replaced flat hamburger nav with grouped, platform-optimized navigation
  - **Desktop (≥768px):** Horizontal nav with dropdown groups (hover/click to expand)
    - "Research" dropdown → Research, Projects, News
    - "People" dropdown → Team, Opportunities
    - "Classes" → direct link
    - Auth items (Lab Apps, Dashboard, Admin, Login) shown inline when applicable
    - Chevron icon rotates on dropdown open; group button highlighted when child page is active
  - **Mobile (<768px):** Fixed bottom tab bar with 4 tabs: Research, People, Classes, More
    - Group tabs open bottom sheets with sub-links (Research sheet, People sheet, More sheet)
    - Sheets dismiss on backdrop tap, link click, or Escape key
    - Only one sheet open at a time
  - **Mission removed from nav** — now a splash page accessed via logo click only
  - `NAV_GROUPS` route-to-group map drives group-aware active state highlighting
  - `setupDesktopDropdowns()`/`closeAllDropdowns()` for desktop hover/click dropdowns
  - `toggleGroupSheet()`/`closeAllSheets()` for mobile bottom sheets
  - Auth-gated items toggled across all nav surfaces via `updateNavigation()` in `user-system.js`
=======
- **Navigation redesign** — replaced hamburger-only nav with platform-optimized patterns
  - **Desktop (≥768px):** Horizontal inline nav bar in `.top-banner` — all pages accessible in one click
    - New `#desktop-nav` element with pill-style links, `aria-current="page"` active state
    - Banner grid updated to `auto 1fr auto` (brand | nav | user button)
    - Hamburger and drawer hidden via CSS
  - **Mobile (<768px):** Fixed bottom tab bar (`#bottom-tabs`) with 4 primary tabs + "More" sheet
    - Tabs: Home (Mission), Research, Team, News — inline SVG icons
    - "More" button opens `#more-sheet` bottom sheet with Projects, Classes, Opportunities, auth items, Login
    - Sheet dismisses via backdrop tap, link click, or Escape key
    - `env(safe-area-inset-bottom)` for iPhone home indicator
    - Footer padding added to prevent content occlusion
  - **Auth-gated items** toggled across all 3 nav surfaces (drawer, desktop nav, more sheet) via `updateNavigation()` in `user-system.js`
  - New CSS variable `--tab-bar-height: 60px`
  - Z-index layers updated: `.bottom-tabs` at 100, `.more-sheet` at 110
  - `prefers-reduced-motion: reduce` disables sheet animation

### Added
- `setupBottomTabs()`, `toggleMoreSheet()`, `closeMoreSheet()` functions in `app.js`
- `setActiveTopNav()` now updates active state across desktop nav, drawer, bottom tabs, and more sheet
>>>>>>> Stashed changes

## [V3.14] - 2026-03-24

### Added
- **Lab Apps hub** — new private section (`#/apps`) for internal lab applications, accessible only to authenticated non-guest members
  - `lab-apps.js` — hub renderer (card grid) + iframe embedder with postMessage auth bridge
  - **App registry** (`LAB_APPS` array) with `path` field pointing to each app's standalone `index.html`
  - Four standalone apps, each a self-contained mini-site under `apps/`:
    - `apps/inventory/` — Inventory Tracker (supply and equipment tracking)
    - `apps/equipment/` — Equipment Scheduler (Google Calendar integration)
    - `apps/meetings/` — Lab Meeting (agenda and presentation scheduling)
    - `apps/console/` — Admin Console (master control panel, admin-only)
  - Each app has own `index.html`, `app.js`, `styles.css` — can run independently or embedded
  - Grid layout with icon cards, descriptions, and "Coming Soon" status badges
  - Admin Console card displays "Admin" badge and is only visible to admin-role users
- **Standalone app architecture** (`apps/` directory)
  - `apps/shared/auth-bridge.js` — dual-mode auth handshake: postMessage (embedded in iframe) or Firebase `onAuthStateChanged` (standalone)
  - `apps/shared/app-base.css` — common dark-theme base styles, buttons, inputs, cards, auth wall
  - Protocol: child sends `mcgheelab-app-ready` → parent responds with `mcgheelab-auth` (user + profile)
  - Embedded mode: app header hidden, iframe sandboxed with `allow-same-origin allow-scripts allow-forms allow-popups`
  - Standalone mode: full page with Firebase SDK, "Back to Lab Apps" header, direct `onAuthStateChanged`
  - 5s auth timeout in embedded mode → shows sign-in wall fallback
- **Auth-gated navigation** — "Lab Apps" nav item (`#nav-apps`) visible only to logged-in users with role !== 'guest'
- **Routing** — `#/apps` hub and `#/apps/{appId}` sub-routes in `app.js` render switch and wire switch; auth re-render on state change
- **Styles** — `.lab-apps-page`, `.lab-apps-grid`, `.lab-app-card`, `.lab-app-iframe-wrap` in `user-styles.css` with responsive mobile layout

## [V3.13] - 2026-03-24

### Changed
- **Repeatable sections** (`class-builder.js`)
  - Removed uniqueness constraint: any section type (Overview, Simulations, Files, etc.) can now be added multiple times to the same or different tabs
  - `buildSectionDropdownItems()` no longer accepts `usedKeys` or disables already-used types
  - `addSection(key)` prompts for a custom name on creation and no longer checks `getAllUsedSections()`
- **Nameable sections** (`class-builder.js`)
  - Each section instance stores a `name` field (user-chosen display name)
  - Section chrome and readonly headers display the custom name; type badge shows the SECTION_REG label
  - Double-click section label in admin mode to rename (`renameSection()`, `wireSectionRename()`)
- **Collapsible sections** (`class-builder.js`, `user-styles.css`)
  - Each section stores a `collapsed` boolean, persisted to Firestore
  - Collapse toggle button (▶/▼) in both admin chrome and public header row
  - `toggleSectionCollapse()` updates DOM in-place (no full re-render), toggling `.cb-collapsed` class
  - `.cb-section-collapsible.cb-collapsed { display: none }` hides body+widgets
  - `wireSectionCollapse()` wired for all views (admin, preview, public)
- **Per-section content storage** (`class-builder.js`)
  - Text-component sections now store content on `section.content` instead of `_classData[reg.field]`
  - Each section instance has independent text content (two "Overview" sections have separate text)
  - `gatherContentFromDOM()` writes to section objects via `.cb-section-text[data-section-id]`
  - `persistAll()` simplified: text content saved within `tabs` array, no separate field copying
- **Per-section file paths** (`class-builder.js`)
  - File sections use `section.storagePath` for unique Firestore queries
  - New sections get `storagePath = section.id`; migrated sections keep `reg.path || key`
  - `_fileData` keyed by `section.id` instead of `section.key`
  - `handleFileUpload()` and `handleFileDelete()` use `data-section-id` and `findSectionById()`
- **Section type CSS hooks** (`user-styles.css`)
  - All sections get `.cb-section-type-{key}` class (e.g., `.cb-section-type-simulations`)
  - Default colored left borders per type: simulations (#4fc3f7), overview (#81c784), syllabus (#ce93d8), schedule (#ffb74d), speakers (#f06292), files (#90a4ae), lectures (#aed581), homeworks (#ffd54f), exams (#ef5350)
- **Migration** (`class-builder.js`)
  - `migrateLegacy()` populates `name`, `collapsed`, `content`, `storagePath` on all sections
  - Existing text content migrated from `schedule[reg.field]` → `section.content`
  - Speakers sections use dynamic container ID (`cb-speakers-{section.id}`)

## [V3.12] - 2026-03-24

### Added
- **Simulation widget** (`class-builder.js`, `user-styles.css`)
  - New `simulation` entry in `WIDGET_REG` — admins can add Simulation widgets to any section
  - Admin editor: title input + monospace code textarea for HTML/JS simulation source, with live preview iframe
  - Public/student view: sandboxed `<iframe srcdoc>` (`sandbox="allow-scripts"`) executes simulation safely
  - **Student code editing:** "Edit Code" toggle reveals a local copy of the source; "Run" re-renders the iframe; "Reset" restores original admin code. Edits are ephemeral and never persist to Firestore
  - **Fullscreen mode:** "Fullscreen" button uses Fullscreen API on the simulation container; toolbar auto-hides (hover to reveal), code panel anchors to bottom
  - **Data export:** Simulations can call `SimExport.log(label, value)` to record data points; "Export Data" button flushes data via `postMessage` bridge and triggers CSV download (`timestamp, label, value` columns)
  - `buildSimSrcdoc(code)` injects `SimExport` bridge preamble (with `postMessage`-based flush) before user HTML
  - `wireSimulations()` wired from `wireCanvas()` for both admin and public views — handles toggle-code, run, reset, export, fullscreen, and `__WID__` placeholder patching
  - `downloadSimCSV(widgetId)` converts logged data to CSV blob and triggers browser download
  - `gatherContentFromDOM()` now collects `.cb-sim-code` and `.cb-sim-title` inputs
  - CSS: `.cb-sim-container`, `.cb-sim-toolbar`, `.cb-sim-code-panel`, `.cb-sim-student-code`, `.cb-sim-iframe` with fullscreen overrides (`:fullscreen` / `:-webkit-full-screen`)

### Changed
- **Team card layout** (`styles.css`) — All team cards (PI and regular) now use a consistent `1fr 2fr` grid: photo takes 1/3 of card width, info takes 2/3, aligned top-left. Removed legacy `.person img { width: 25% }` rule that was cropping photos at ≤768px.
- **PI card consistency** (`styles.css`) — PI cards now share same 1/3-photo layout as other team cards. Bio capped at 8 lines with scroll overflow. Learn More button and badges sit in a horizontal footer row at card bottom.
- **Team grid min card width** (`styles.css`) — Bumped from 220px to 280px so grid collapses to single column on narrow screens before photos get too small.
- **Expanded sections collapsed by default** (`app.js`, `styles.css`) — PI "Learn More" detail sections now all start collapsed. Added CSS triangle indicator (`::after` on `<summary> h4`) that rotates 180deg when open.

### Added
- **LinkedIn, ResearchGate, Google Scholar profile links** (`user-system.js`, `app.js`)
  - Three new badge definitions in `BADGE_DEFS`: `linkedin`, `researchgate`, `googleScholar` with brand SVG icons
  - Profile editor gains three new `<details>` sections with URL input + Save button for each service
  - Save handlers write `linkedin`, `researchgate`, `googleScholar` fields to Firestore user doc
  - `buildBadgesHTML()` renders clickable badge links for each populated field
- **News cover image support** (`app.js`, `user-system.js`, `user-styles.css`)
  - `buildNewsFeedCard()` now reads `p.coverImage.medium` / `p.coverImage.full` and renders a horizontal grid layout (`.news-cover-layout`): cover image on left (280px), text content on right; stacks vertically on mobile ≤ 600px
  - Cards with a cover image get `.news-has-cover` class with zero padding and overflow hidden for clean edge-to-edge image display
  - News editor (`renderNewsEditor`) gains a cover image upload zone (`#news-cover-zone`) with drag-and-drop support, using the existing `processImage()` + `uploadImageSet()` pipeline
  - `wireNewsEditor()` adds `coverImageUrls` state, `handleCoverUpload()`, and loads existing cover on edit
  - `collectData()` now includes `coverImage` field in saved data

## [V3.11] - 2026-03-23

### Added
- **How-to guides for News Posts and Scheduler** (`user-system.js`)
  - `renderGuide()` rewritten as tabbed page with three panels: Stories, News Posts, Scheduler
  - New `wireGuide()` function handles tab switching; reads `?tab=` param from hash URL to select initial tab (e.g., `#/guide?tab=scheduler`)
  - **News Posts guide:** Covers creating a post, choosing categories (Event/Conference/Paper/Highlight/Lab Life/Other), adding sections with media, preview & publish workflow, and feed features (reactions, comments)
  - **Scheduler guide:** Covers creating a scheduler, choosing modes (Sessions vs Freeform), setting up the calendar + time grid builder, configuring guest fields, adding guests & sharing invite links, guest perspective, and auto-assign
  - Dashboard cards for "My News Posts" and "My Schedulers" now include "How-to Guide" links pointing to the correct tab
  - Guide tab CSS: `.guide-tabs`, `.guide-tab`, `.guide-tab-active` with accent-colored active state
  - `wireGuide` exported on `McgheeLab` namespace; wired from `app.js` router

### Bug Fixes
- **Unified builder row height** (`user-styles.css`) — Added `grid-template-rows: auto` + `grid-auto-rows: 18px` to `.sb-daygrid-inner` so all time-slot rows are uniform height; previously the first hour row was taller due to content-based auto-sizing

## [V3.10] - 2026-03-23

### Changed
- **scheduler.js** — Unified builder: both session and freeform modes share same side-by-side layout
  - **Side-by-side layout:** Calendar on left, scrollable day-column time grid on right (7am–9pm, 15-min rows)
  - **Day columns:** One column per selected day with date headers and clear column borders; grid updates live as days are toggled on the calendar
  - **Session mode:** Admin sets session duration (15m–2hr dropdown), then clicks grid cells to place blocks of that length per day; click existing block to remove; no more drag-to-select-and-apply-to-all-days
  - **Freeform mode:** Same grid layout; click+drag to paint/erase individual cells per day (like when2meet); stored as `freeformCells` array of `day-HHMM` keys
  - **Session block model:** Changed from `{ days: [...], start, end }` to `{ day: string, start, end }` (one block per day); backward compat: `expandSchedule()` and `calendarHTML()` accept both `sb.day` and `sb.days`
  - **New data fields:** `freeformCells` (array), `sessionDuration` (minutes) stored on schedule doc
  - **`wireSetupForm()` rewritten:** Single `mountBuilder()` function swaps between modes; `builderApi` provides `.getBlocks()`, `.getCells()`, `.getDays()`, `.getDuration()` getters for save
  - **Exports:** `renderSessionBuilder` / `wireSessionBuilder` → `renderBuilder` / `wireBuilder`
- **user-styles.css** — Replaced `.session-builder` / `.sb-time-grid` / `.sb-tg-*` CSS with `.sb-unified` side-by-side layout, `.sb-daygrid-inner` CSS grid, `.sb-dg-dayhead`, `.sb-dg-cell`, `.sb-dg-block`, `.sb-dg-selected` styles; sticky day headers; responsive stacking at 600px

## [V3.9] - 2026-03-23

### Added
- **Tab system** (`class-builder.js`) — Admin can create, name, rename (double-click), and delete tabs as top-level navigation for class pages
  - `_tabs` array replaces flat `_layout` — each tab has `{ id, name, sections }` structure
  - `migrateLegacy()` automatically converts old `layout` or `sections` formats into a single "Home" tab
  - `genTabId()`, `getActiveTab()`, `switchTab()`, `addTab()`, `deleteTab()`, `renameTab()` tab management functions
  - `getAllUsedSections()` enforces section uniqueness across all tabs
  - `tabsToSections()` derives flat sections array for backwards compatibility
- **Admin/public view toggle** — Preview button in header switches between editing view and read-only public view
  - `_previewMode` boolean flag; `togglePreview()` function
  - `isEditing()` helper replaces all `_viewType === 'admin'` checks throughout renderers
  - Preview banner shown at top when in preview mode
- **Nested widgets** — Widgets can only be added inside sections via "+ Widget" dropdown button
  - Each section has a `widgets` array of `{ kind, id, content?, url?, caption?, items?, html? }` objects
  - `addWidget(sectionId, kind)`, `removeWidget(widgetId)`, `moveWidget(widgetId, direction)` management functions
  - `findWidgetById(id)` and `findSectionForWidget(widgetId)` helpers search active tab's nested structure
  - `buildSectionBlockHTML()` renders section chrome + body + nested widgets + add widget dropdown
  - `buildWidgetBlockHTML()` renders widget chrome + body, nested inside parent section

### Changed
- **class-builder.js** — Full rewrite from flat layout to tab-based architecture
  - Data model: `tabs: [{ id, name, sections: [{ key, id, widgets: [...] }] }]`
  - Removed three-column palette layout; replaced with "Add Section" dropdown at top + "Add Widget" dropdowns inside sections
  - Section management: `addSection()`, `removeSection()`, `moveSection()`, `reorderSection()` operate on active tab
  - DnD limited to section reordering within canvas; widget reordering via arrow buttons
  - `gatherContentFromDOM()` updated to search active tab's sections' widgets via `findWidgetById()`
  - `persistAll()` saves `tabs` field + derived `sections` array + text content fields
  - Widget renderers use `data-widget-id` attributes (was `data-block-id`)
  - File/image handlers updated: `btn.closest('.cb-section')` replaces `btn.closest('.cb-block')`
- **user-styles.css** — Replaced palette/block CSS with tab bar + section + nested widget styles
  - New: `.cb-tab-bar`, `.cb-tab`, `.cb-tab-active`, `.cb-tab-add`, `.cb-tab-delete`, `.cb-tab-name`
  - New: `.cb-section`, `.cb-section-chrome`, `.cb-section-handle`, `.cb-section-label`, `.cb-section-readonly`, `.cb-section-title-readonly`
  - New: `.cb-widget`, `.cb-widget-chrome`, `.cb-widget-label`, `.cb-widgets-area`, `.cb-widget-readonly`
  - New: `.cb-add-section-bar`, `.cb-add-widget-bar`, `.btn-ghost`, `.cb-preview-banner`
  - Removed: `.cb-builder` (three-column grid), `.cb-palette`, `.cb-palette-item`, `.cb-block`, `.cb-block-chrome`, `.cb-block-handle`, `.cb-mobile-add-bar`

## [V3.8] - 2026-03-23

### Added
- **Session Builder** (`scheduler.js`) — Visual calendar + drag-to-select time grid replaces manual session time entry
  - **Calendar with session colors:** Days belonging to saved session blocks show colored backgrounds and dots; active selection (days being picked) highlighted separately
  - **Scrollable time grid:** 7 AM – 9 PM in 15-min rows; existing session blocks rendered as colored overlays; user drags vertically to select a time window
  - **Drag-to-select:** Pointer events API for click+drag time range selection; Apply button confirms and saves the session block
  - **Session block list:** Summary of all created sessions with color swatches, time ranges, day lists, and remove buttons
  - **`sessionBlocks` data model:** Array of `{ id, days, start, end, color }` objects stored on schedule doc; `expandSchedule()` derives days + slotDefs from sessionBlocks with backward compat fallback
  - **5-color palette:** `SESSION_COLORS` array (blue, amber, green, purple, rose) for distinguishing session groups
  - New exports: `renderSessionBuilder`, `wireSessionBuilder`
- **Session builder CSS** — `.session-builder`, `.sb-time-grid`, `.sb-tg-row`, `.sb-tg-cell`, `.sb-tg-dragging`, `.sb-sessions`, `.sb-session-item`, `.sched-cal-saved`, `.sched-cal-dots`, `.schedule-slot-disabled` styles; responsive at 600px

### Changed
- **scheduler.js `setupFormHTML()`** — Sessions mode now renders session builder component instead of manual slot definition rows
- **scheduler.js `wireSetupForm()`** — Wires session builder; save gathers `sessionBlocks` and derives `selectedDays` + `slotDefs` for backward compat
- **scheduler.js `expandSchedule()`** — Prefers `sessionBlocks` → `selectedDays` → `startDate/endDate`; sessions mode creates allSlots only for day+time combos that exist in sessionBlocks
- **scheduler.js `sessionsGridHTML()`** — Marks cells as disabled (`.schedule-slot-disabled`) when a day+slot combo doesn't exist in sessionBlocks
- **scheduler.js `guestViewHTML()`** — Guest availability grid skips invalid day+slot combos (shows disabled cells)
- **scheduler.js `calendarHTML()`** — Now accepts `sessionBlocks` param for coloring saved days; shows colored dots for multi-session days
- **user-system.js** — Dashboard scheduler creation form simplified: removed date range inputs, schedules created with empty `sessionBlocks` array (configured later in admin Settings)
- **user-system.js** — Scheduler list shows session count instead of date range for schedules with sessionBlocks

## [V3.7] - 2026-03-23

### Changed
- **scheduler.js** — Full redesign: bare-bones by default, calendar day picker, view renaming
  - **View renaming:** `speaker` → `guest`, `student` → `public`; `normalizeView()` accepts both old and new names for backward compat
  - **Calendar day picker:** New `calendarHTML()` / `wireCalendar()` components — month-view calendar with multi-select click-to-toggle days; replaces date range input for session setup
  - **`selectedDays` data model:** Schedule stores explicit `selectedDays: ['2026-06-08', ...]` array instead of generating all days from a date range; `expandSchedule()` prefers `selectedDays`, falls back to `startDate/endDate`
  - **Session-first setup flow:** Define session time slots first → pick days from calendar → review grid (instead of date range → slots)
  - **Simplified admin view:** Settings collapsed behind `<details>` by default; optimization button only appears when there are unassigned guests with availability
  - **View switcher labels:** Admin / Guest / Public
- **user-system.js** — Updated `wireSchedulePage` config: `viewType: 'guest'` and `adminViewMode: 'guest'` (was `'speaker'`)
- **class-builder.js** — Updated view type logic: default `'public'` (was `'student'`), speaker detection returns `'guest'` (was `'speaker'`), file upload permission checks use `'guest'`

### Added
- **Calendar CSS** — New `.sched-calendar`, `.sched-cal-grid`, `.sched-cal-day`, `.sched-cal-selected`, `.sched-cal-header`, `.sched-cal-prev/.sched-cal-next` styles in `user-styles.css`; responsive at 600px breakpoint

## [V3.6] - 2026-03-23

### Added
- **Dashboard schedulers** — Any logged-in user can create and manage scheduling tasks from the dashboard
  - "My Schedulers" card in dashboard: create form (title, mode, date range), list with manage/delete, speaker count
  - `#/dashboard/scheduler/{id}` route: owner/admin view with full scheduler engine (add speakers, get invite URLs, configure, optimize)
  - `#/schedule/{id}?key={uuid}` route: private speaker access (key-only, no login required, no public nav link)
  - Invite URLs point to `#/schedule/` (not `#/classes/`) — completely private
  - Reuses `McgheeLab.Scheduler` engine and `ScheduleDB` — no new scheduler code
  - New exports: `renderSchedulerEditor`, `wireSchedulerEditor`, `renderSchedulePage`, `wireSchedulePage`
- **Drag-and-drop course builder** — Complete rewrite of `class-builder.js` from sidebar navigation to a canvas-based page builder
  - **Three-column layout:** Left palette (sections) + center canvas (drop zone) + right palette (widgets)
  - **HTML5 Drag and Drop:** Drag from palettes into canvas; drag handle on blocks to reorder within canvas
  - **Section blocks** (9 types): overview, syllabus, schedule, speakers, files, simulations, lectures, homeworks, exams — each renders inline in canvas (text editor, file manager, or scheduler)
  - **Widget blocks** (6 types): text block, image (with upload + caption), video (YouTube/Vimeo embed or direct URL), link list, HTML embed, divider
  - **Autosave:** 30-second interval with dirty flag; status indicator (Saved/Unsaved/Saving/Error); manual "Save Now" button; auto-saves on page leave
  - **Layout persistence:** Ordered `layout` array in Firestore schedule doc; backwards compatible with `sections` array (auto-derived on save; falls back to `sections` if no `layout` field)
  - **Settings modal:** Title, subtitle, semester, description + Scheduler setup form
  - **Mobile support:** Palettes collapse below 1024px; dropdown "Add Section/Widget" buttons replace drag; up/down arrow buttons for reorder; `beforeunload` warning for unsaved changes
  - **Block chrome:** Drag handle, label, type badge, move up/down, remove button
  - Sections are unique (one per type); widgets can be added multiple times
  - Palette dims used sections with checkmark indicator

### Changed
- **class-builder.js** — Full rewrite from sidebar+switchSection to canvas-based builder (all 5 phases: autosave, canvas layout, DnD, block renderers, persistence)
- **user-styles.css** — Replaced sidebar CSS with canvas builder CSS: `.cb-builder` grid, `.cb-palette`, `.cb-block` with chrome/body, `.cb-drop-indicator`, `.cb-autosave-status`, `.cb-modal-overlay`, responsive breakpoints at 1024px/768px

## [V3.5] - 2026-03-23

### Added
- **Firestore-driven classes listing** — Classes page now loads course listings from Firestore `classes` collection instead of hardcoded `content.json` entries
  - New DB methods: `getPublishedClasses()`, `getAllClasses()`, `saveClass(data)`, `deleteClass(id)` in `user-system.js`
  - Admin panel "Course Listings" form: title, description, level, when, detail page link, registration link, display order, published/draft status
  - `renderClasses()` shows loading placeholder, then populates from Firestore; empty state when no courses published
  - Firestore rules: `classes` collection — public read, admin write
- **Standalone scheduler engine** (`scheduler.js`) — Reusable dual-mode scheduling module extracted from class-builder.js
  - **Freeform mode (when2meet-style):** Admin picks days + time window + increments (15/30/60 min); speakers click+drag to paint availability; admin sees aggregate green heatmap
  - **Sessions mode:** Admin defines named time blocks; speakers vote on preferred slots; greedy bipartite assignment optimizes 1-to-1 matching
  - **Three views:** Admin (setup + heatmap + speaker management + optimization), Speaker (availability + submission form), Student (read-only grid + confirmed speakers)
  - **Zero module state** — all state passed via config object; host provides persistence callbacks (`onSaveSpeaker`, `onSaveSchedule`, `onAddSpeaker`, `onDeleteSpeaker`, `onRefresh`, `onSwitchView`)
  - **Public API:** `McgheeLab.Scheduler.render(config)` / `.wire(containerId, config)` + sub-components (`renderGrid`, `renderSetupForm`, `wireSetupForm`, `renderConfirmedSpeakers`, `expandSchedule`, `optimizeSchedule`)
  - **Embeddable anywhere** — not tied to class pages; can be used for events, conferences, lab scheduling, etc.

### Changed
- **class-builder.js** — Stripped of all scheduler code (~600 lines removed); now a thin class builder that delegates speakers section to `McgheeLab.Scheduler.render()` / `.wire()` via `buildSchedulerConfig()` which constructs the config with ScheduleDB callbacks
- **index.html** — Added `scheduler.js` script tag before `class-builder.js` in loading order
- **Admin panel: unified course creation** — "Add Course Listing" now auto-creates both a `classes` doc (public listing) and a `schedules` doc (course builder page) in one step
  - Schedule ID auto-generated from title (lowercase, hyphenated, max 40 chars)
  - Duplicate schedule ID check before creation
  - Removed separate "Create New Class Schedule" form and `loadClassSchedules()` function
- **Admin panel: course list actions** — Course listing table now shows Edit and Delete buttons
  - Edit navigates to `#/classes/<detailPage>` (the course builder)
  - Delete performs cascading removal: `classes` doc → `participants` → `classFiles` (Firestore + Storage blobs) → `schedules` doc

## [V3.4] - 2026-03-23

### Changed
- **PI "Read More" section** — Redesigned as a CV-style view with collapsible sections, filter bar, citation counts, and year-based ordering
  - `buildPiExpandedHTML(user)` — now builds `<details>` collapsible sections per category (Publications, Patents, Presentations, Posters, Protocols, Research Stories)
  - **Filter bar** — chip-style filter at top of expanded section; "All" + per-category chips; shows/hides sections; only appears when 2+ categories have content
  - **Citation counts** — journal papers display `N cited` badge when citations > 0
  - **Year sort** — all items within each section sorted by year descending; items without year fall to bottom
  - **Rich metadata** — publications show journal name, volume, issue, pages; presentations show event + type; patents show inventors + status
  - `wirePiCvFilter(container)` — new function wires chip click handlers for filter bar
  - First non-empty section starts open by default; others collapsed
- **`syncCVToProfile(uid, cvData)`** — enriched sync from CV builder to user profile now includes:
  - Papers: `year`, `citations`, `journal`, `authors`, `volume`, `issue`, `pages`, `status`
  - Posters: `year`, `conference`, `authors`
  - Presentations: `year` (extracted from date), `event`, `type`
  - Patents: `year` (from grant/filing date), `status`, `inventors`
- **styles.css** — Added `.pi-cv-filter`, `.pi-cv-chip`, `.pi-cv-year`, `.pi-cv-citation`, `.pi-cv-meta`, `.pi-cv-detail-section` styles

### Added
- **CV Settings: "Re-sync to Profile" button** — New button in CV Builder Settings that pushes all CV data to the user's public profile on demand; calls `syncCVToProfile()` with status feedback (syncing/done/failed)

### Bug Fixes
- **HTML tags in paper titles** — CrossRef API returns HTML-formatted titles (e.g. `<i>In-Situ</i>`) that rendered as literal text on the Team page. Fixed in two places:
  - `fetchDOI()` in cv-builder.js now strips HTML tags from titles on import
  - `syncCVToProfile()` in user-system.js strips HTML tags from all title fields via `stripTags()` helper — cleans existing data on re-sync

## [V3.3] - 2026-03-23

### Added
- **Section-based class builder** — Complete rewrite of class system into a configurable class builder with sidebar navigation and three reusable component types
  - `class-builder.js` — section registry pattern (`SECTION_REG`) maps 9 section keys to 3 component types (text editor, file manager, speakers scheduler)
  - **Section registry:** overview, syllabus, schedule, speakers, files, simulations, lectures, homeworks, exams — each class picks which sections to enable
  - **Text component** — admin gets textarea editor with save + preview; students see read-only rendered content (auto-links URLs, paragraph formatting)
  - **File manager component** — upload files to Firebase Storage, metadata stored in `classFiles` Firestore collection; admin+speaker can upload, students download only; optional due date field for homeworks/exams; file size display
  - **Speakers component** — full dual-mode scheduler preserved from initial build: sessions + freeform modes, invite key access, availability voting, drag-select, heatmap visualization, optimization, talk submission
  - **Sidebar navigation** — sticky sidebar on desktop, horizontal chips on mobile (768px breakpoint); admin gets Settings section at bottom
  - **Settings section** — admin toggles which sections are enabled via checkboxes; schedule setup form for speakers mode config
  - **Three role-based views:** admin (full edit), speaker (availability + submission), student (read-only)
  - **Admin view switcher** — admin can preview class as speaker or student
  - **Module-level state caching** — `_classData`, `_speakers`, `_activeSection` etc. cached at module scope so section switching doesn't re-fetch from Firestore
- **Admin class builder in dashboard** — "Classes" tab in admin panel for creating and managing classes
  - Create form: schedule ID, title, subtitle, semester, description, section checkboxes (9 available sections), mode (sessions/freeform), date range
  - Schedule listing table with mode badge, dates, semester, "Open" link to class page, "Delete" button
  - Delete cascades to all participants in the schedule
- **BME 295C default class** — hardcoded seed with sections: overview, speakers, files (sessions mode, Summer 2026, June 8–12)
- **Firestore rules** for `schedules` (public read, owner/admin write), `participants` (public read, admin create/delete, key-based or UID-based self-update), and `classFiles` (public read, auth create, admin update/delete)
- **Storage rules** for `classes/{classId}/` — public read, auth write, 50 MB limit
- **ScheduleDB file operations** — `getFiles(classId, section)`, `addFile(data)`, `deleteFile(fileId, storagePath)` for the `classFiles` collection
- **Invite key system** — admin generates UUID invite keys per speaker; public URL `#/classes/<id>?key=<token>` grants access without login
- **Schedule optimization** — greedy constraint-based bipartite assignment: sorts speakers by most-constrained first, assigns to least-contested available slot
- **Classes page** — courses with `detailPage` field render as clickable links with "View Class" button
- **Class builder CSS** — sidebar layout, section navigation, file upload area, text preview, settings checklist, confirmed speaker cards, responsive mobile layout (sidebar → horizontal chips)

### Changed
- **content.json** — Added BME 295C course entry with `detailPage: "bme295c"` field
- **app.js** — Added `#/classes/<slug>` sub-route with query string stripping (render + wire delegation); `renderClasses()` now generates links for courses with `detailPage`; added `detailPage` to course normalizer
- **index.html** — Added `class-builder.js` script tag
- **user-system.js** — Added "Classes" tab in admin panel with section-aware create form (9 section checkboxes); `loadClassSchedules()` lists/deletes schedules
- **user-styles.css** — Added scheduler grid styles + class builder layout (sidebar, section nav, file upload, text preview, settings, confirmed speaker cards, responsive breakpoints)
- **firestore.rules** — Added `classFiles` collection rules
- **storage.rules** — Added `classes/{classId}/` storage path

## [V3.2] - 2026-03-23

### Added
- **CV Builder page** (`#/cv`) — Full-featured academic CV management tool for authenticated lab members
  - New files: `cv-builder.js` (~1,800 lines), `cv-styles.css` (~400 lines)
  - 11 data sections: Profile, Education, Employment, Journals, Conferences, Presentations, Patents, Grants, Awards, Teaching, Service
  - Per-section schemas with typed fields (text, textarea, number, date, url, select, chips)
  - Dashboard with section counts, completeness stats, quick-add actions
  - Analytics charts via Chart.js CDN (publications over time, category breakdown)
  - DOI auto-fill via CrossRef API
  - BibTeX import/export (paste or file upload, context-aware section detection)
  - NSF document parsing (Current & Pending, Biographical Sketch)
  - LaTeX export (moderncv template)
  - PDF generation with 3 templates (classic, modern, NSF) via browser print
  - ORCID sync (public API works search by ORCID ID)
  - Citation tracker via CrossRef cited-by counts
  - AI writing assistant using per-user Anthropic API key stored in Firestore profile
  - CV versioning with section/entry visibility toggles and named snapshots
  - Settings panel for API keys, ORCID ID, and preferences
- **Bidirectional association sync** — CV entries auto-sync to user profile fields:
  - journals → papers, conferences → posters, presentations → presentations, patents → patents
  - `DB.syncCVToProfile()` called on every CV save; existing profile associations auto-imported on first CV load
- **Firestore rules** for `cvData/{userId}` — owner read/write, admin read
- **Storage rules** for `cv/{userId}/` — BibTeX, PDF, images up to 20 MB
- **Navigation** — "CV Builder" link in nav drawer (visible to non-guest authenticated users)
- **CV-specific CSS** — Dark theme with gold accent, responsive sidebar/bottom-nav layout

### Changed
- **index.html** — Added Chart.js CDN, cv-builder.js script tag, cv-styles.css link, CV Builder nav item
- **app.js** — Added `#/cv` route case (render + wire), hero hidden on CV page, auth re-render includes CV
- **user-system.js** — Added `DB.getCVData()`, `DB.saveCVData()`, `DB.syncCVToProfile()` methods; CV nav visibility logic in `Auth.updateNavigation()`

## [V3.1] - 2026-03-23

### Added
- **News page** (`#/news`) — Public feed of lab news posts with reactions and comments
  - New `renderNews()`, `buildNewsFeedCard()`, `wireNewsFeedInteractions()` in `app.js`
  - Reuses existing story-feed card layout, expandable sections, reactions, and comments systems
  - Category tags: Event, Conference, Paper, Highlight, Lab Life, Other
- **News post editor** — Simplified version of story editor (no project/team/references)
  - `renderNewsEditor()`, `wireNewsEditor()` in `user-system.js`
  - Sections with text + optional image/video upload (same media pipeline as stories)
  - Contributors submit for review; editors/admins publish directly
- **News DB operations** — Full CRUD in `DB` object: `getNewsPost`, `getNewsByUser`, `getPublishedNews`, `getPendingNews`, `saveNewsPost`, `updateNewsStatus`, `deleteNewsPost`
- **Dashboard "My News Posts" section** — Card with post list, create/edit/delete actions
  - `refreshNewsList()` helper, `#new-news-btn` → `#/dashboard/news/new`
- **Admin "Pending News" tab** — Review, approve, or reject contributor-submitted news posts
  - `loadPendingNews()` function in admin panel
- **Firestore rules** for `newsPosts` collection — same pattern as stories (public read published, owner/admin write)
- **Storage rules** for `news/{postId}/` — images and videos up to 50 MB
- **Navigation** — "News" link added to header nav drawer and footer links
- **CSS** — `.news-cat-badge` style for category badges

## [V2.4] - 2026-03-20

### Added
- **Video upload in stories** — Story sections can now include video (mp4/webm) alongside or instead of images
  - Upload zone accepts `image/*`, `video/mp4`, `video/webm`; detects type automatically
  - Videos uploaded directly to Firebase Storage (no client-side transcoding); 50 MB limit
  - `handleMedia()` replaces `handleImage()` — routes files to image pipeline or video upload
  - `sectionVideos` map tracks video URLs per section alongside existing `sectionImages`
  - `collectData()` includes `video` field per section
  - Preview modal renders `<video>` with controls for video sections
  - Existing stories with video data restored correctly on editor load
- **Video rendering on public pages** — `buildStoryHTML()` checks `block.video` and renders `<video controls playsinline preload="metadata">` in two-column layout
- **Video styles** — `.section-video-preview`, `.preview-video`, `.story-video` classes for editor, preview, and public display

### Changed
- **Storage rules** — Stories path now accepts `video/mp4` and `video/webm` content types; size limit increased to 50 MB
- **Section upload zone** — Renamed from `.image-upload-zone` to `.media-upload-zone`; hint text updated to "image or video"
- **Firestore story augmentation** — Section mapping passes `sec.video` through to story blocks

## [V2.3] - 2026-03-20

### Changed
- **Project packages are admin-only** — `canCreateProject()` now requires admin role (PI level); removed `PROJECT_CATEGORIES`
- **Project editor is a step-by-step wizard** — 5 steps: Details, Team, Stories, References, Review & Publish
  - Step indicators with active/completed states and click-to-jump navigation
  - Previous/Next navigation buttons with Save Draft available on every step
- **Story assignment with ordering** — Step 3 replaces checkboxes with an ordered list; admin adds stories from dropdown, reorders with up/down arrows, removes with delete button
- **External link field** — Projects can link to external sites (shown on public Projects page as "View Project Site" button)
- **Review step** — Step 5 summarizes all project data before publish; warns if outcomes are missing

## [V2.2] - 2026-03-20

### Added
- **Project packages system** — Admin (PI) can compile published stories into project packages with outcomes, team, and references
  - `DB.getProject()`, `DB.getProjectsByUser()`, `DB.getPublishedProjects()`, `DB.saveProject()`, `DB.deleteProject()`
  - `renderProjectEditor()` / `wireProjectEditor()` — Full project wizard with story assignment, outcomes (required for publish), team selectors, and reference inputs
  - Dashboard "Project Packages" card (admin only)
  - Published project packages appear on the Projects page with outcomes, team, and references
  - Route: `#/dashboard/project/new`, `#/dashboard/project/:id`
- **Opportunities page** — Replaces the Contact page; public job board managed by admins
  - `DB.getOpenOpportunities()`, `DB.getAllOpportunities()`, `DB.saveOpportunity()`, `DB.deleteOpportunity()`
  - `renderOpportunities()` / `wireOpportunities()` — Public page showing open positions with type badges, deadlines, and apply links
  - Admin panel "Opportunities" tab for creating/deleting job postings
  - Route: `#/opportunities` (old `#/contact` redirects automatically)
- **Category-based default roles** — `CATEGORY_DEFAULT_ROLE` mapping auto-sets role when admin selects category in invitation form
  - grad/postdoc → editor, undergrad/highschool → contributor
  - `syncRoleToCategory()` wired to category dropdown + profile selection
- **`Auth.canCreateProject()`** — Permission check for project package creation (admin or grad/postdoc category)
- **`PROJECT_CATEGORIES`** constant — Defines which categories can create projects
- Firestore rules for `projectPackages` and `opportunities` collections

### Changed
- **Navigation** — "Contact" replaced with "Opportunities" in header nav and footer
- **Router** — Added `opportunities`, `contact` (redirect), and `dashboard/project/:id` routes
- **User system dark theme** — Complete restyle of `user-styles.css` to match main site dark theme
  - All backgrounds now use `--surface`, `rgba(255,255,255,.04)` instead of white
  - Text colors use `--text` and `--muted` instead of `#111`/`#666`
  - Accent changed from indigo `#6366f1` to site accent `--accent` (#5baed1)
  - Cards, buttons, inputs, badges, modals all updated
  - Guide page, admin panel, dashboard all visually consistent with public pages
- **Admin panel** — Added "Opportunities" tab with create form and listing table
- **`renderContact()`** removed from `app.js`

## [V2.1] - 2026-03-20

### Added
- **Story-team connections** — Stories now have author, contributors, and mentor fields linked to registered users
- **Team display in expanded view** — When a story is expanded (Read more), team members appear first with photo, name, and role in a responsive grid
- **Reference system** — Stories can link to publications, patents, presentations, and posters; each reference has title, URL, and detail
- **References in expanded view** — Full reference list rendered after story sections, grouped by category with icons
- **Reference badges on cards** — Unopened story/project cards show compact badge links to associated publications, patents, presentations, posters
- **Story editor team selectors** — Author auto-filled, mentor dropdown, contributor multi-select with chip display (add/remove)
- **Story editor reference inputs** — Repeatable reference rows with type dropdown, title, URL, and detail fields
- New app.js helpers: `buildStoryTeamHTML()`, `buildStoryRefsHTML()`, `buildRefLinksHTML()`, `buildExpandedHTML()`

### Changed
- **`normalizeTopicOrProject()`** — Now passes through `team` and `references` fields from content.json / Firestore
- **`renderResearch()`** — Uses `buildExpandedHTML()` for team → sections → refs layout; adds ref badges on cards
- **`renderProjects()`** — Same expanded layout with team + refs
- **Firestore story augmentation** — User-created stories render with full team/refs in expanded view
- **`collectData()` in story editor** — Now includes `team` and `references` objects in saved story data

## [V2.0] - 2026-03-20

### Added
- **User system** — Firebase-backed authentication, profiles, and story management
- **Invitation-based registration** — Admin generates invitation tokens with role/category; students register via invite link (`#/login?token=...`)
- **Privilege system** — Three roles: admin (full access), editor (auto-publish), contributor (stories need approval)
- **Dashboard** (`#/dashboard`) — Logged-in users can edit profile (name, bio, photo, category) and manage their stories
- **Story editor** (`#/dashboard/story/new`, `#/dashboard/story/:id`) — Add/remove/reorder sections, each with text + optional image upload; drag-and-drop image zone; live preview modal
- **Client-side image processing** — Canvas API auto-generates three resolutions (thumb 300px, medium 800px, full 1600px) as webp from a single upload
- **Admin panel** (`#/admin`) — Tabbed interface for user management (change roles), invitation management (generate/copy/track), and pending story review (approve/reject)
- **Firestore integration** — Published user stories appear on the public Projects page alongside content.json entries
- **Content migration script** (`migrate-content.js`) — One-time `McgheeLab.migrateContent()` to push content.json research/projects/team into Firestore
- **Firebase security rules** — `firestore.rules` and `storage.rules` with role-based access control, 10MB upload limit
- **New files:** `firebase-config.js`, `user-system.js`, `user-styles.css`, `migrate-content.js`, `firestore.rules`, `storage.rules`

### Changed
- **Router** — `onRouteChange()` now parses multi-segment hash paths (`#/dashboard/story/:id`) and passes sub-parts to `render()`
- **`render()` function** — Extended with cases for `login`, `dashboard`, `admin`, `logout`; wires user-system page interactivity after DOM insertion
- **Navigation** — Added Dashboard, Admin, and Login/Logout links to `#site-nav`; Dashboard/Admin hidden until authenticated; Login toggles to Logout on auth state change
- **`index.html`** — Added Firebase compat SDK (4 scripts), user-system scripts (3), and `user-styles.css`

### Documentation
- Created `CodeLog/ClaudesPlan/V2.0_user_system.md` — implementation plan
- Updated `ARCHITECTURE.md` with new modules and data flow
- Updated `CHANGELOG.md` (this file)

## [V1.1] - 2026-03-20

### Added
- **SEO metadata** — `<meta>` description, keywords, author tags in `index.html`
- **OpenGraph tags** — `og:title`, `og:description`, `og:image`, `og:type`, `og:url` for social sharing previews
- **Twitter Card tags** — `twitter:card`, `twitter:title`, `twitter:description`, `twitter:image`
- **robots.txt** — Allows all crawlers, points to sitemap
- **sitemap.xml** — Lists all hash routes with priority weights
- **Error boundaries** — `render()` in `app.js` now wraps page rendering in try/catch; shows fallback message instead of blank page on error
- **Email validation** — Contact form checks email format (`/^[^\s@]+@[^\s@]+\.[^\s@]+$/`) before submitting mailto link
- **Fluid body typography** — `font-size: clamp(0.9375rem, 0.875rem + 0.25vw, 1.0625rem)` scales text from 15px to 17px across viewports

### Changed
- **Video path** — Fixed backslash `Videos\Deposit In Lls Video.webm` → forward slash in `index.html:51` (cross-platform fix)
- **Image path casing** — Normalized all `images/` → `Images/team/` in `content.json` to match actual folder name on case-sensitive servers (GitHub Pages)
- **Microfluidic image path** — `images/Microfluidic_Droplet-02.png` → `Images/research/microfluidics/Microfluidic_Droplet-02.png`
- **Mobile breakpoints** — Media blocks and footer now stack at 768px (was 900px); subnav wraps at 769px (was 901px)
- **Hero video hidden on mobile** — `display: none` below 768px to save bandwidth
- **Grid min-width** — `minmax(250px, 1fr)` → `minmax(min(220px, 100%), 1fr)` for better narrow-phone support; forces single-column below 600px
- **Subnav chip sizing** — Increased padding to `10px 14px`, added `min-height: 44px` for WCAG touch target compliance
- **Badge padding** — Increased from `4px 8px` → `6px 10px` for better touch/readability
- **Cache policy** — `safeFetchJSON()` changed from `cache: 'no-store'` to `cache: 'no-cache'` (validates with server instead of always re-fetching)
- **Page title** — `McGheeLab` → `McGheeLab — Bioengineering Research at the University of Arizona`

### Bug Fixes
- **Duplicate team entry** — Removed Elijah Keeswood from `grad` array (kept in `alumni` where he belongs post-graduation)
- **Typo** — `"offereings"` → `"offerings"` in `classes.intro`
- **Hardcoded aria-current** — Removed `aria-current="page"` from Mission nav link in HTML; JS `setActiveTopNav()` manages this dynamically

### Documentation
- Created `CodeLog/ClaudesPlan/V1.1_site_improvements.md` — implementation plan
- Updated `ARCHITECTURE.md` with new files (robots.txt, sitemap.xml)
- Updated `CHANGELOG.md` (this file)

## [V1.0] - YYYY-MM-DD

### Added
- Initial project setup with VSClaude scaffold
- CLAUDE.md with project conventions
- CodeLog documentation structure
- Version control workflow

### Documentation
- Created ARCHITECTURE.md
- Created CHANGELOG.md
