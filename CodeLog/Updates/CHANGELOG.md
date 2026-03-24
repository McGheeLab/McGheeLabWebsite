# Changelog

All notable changes to this project will be documented in this file.

Format: [Keep a Changelog](https://keepachangelog.com/)

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
