# Architecture

**Version:** V3.14

## System Overview

McGheeLab website is a single-page application (SPA) using vanilla HTML, CSS, and JavaScript. It uses hash-based routing to navigate between sections without page reloads. Public site content is stored in content.json, while user-generated content (stories, profiles) lives in Firebase Firestore. Authentication is handled by Firebase Auth with invitation-based registration.

## Module Breakdown

### index.html
- **Purpose:** HTML shell with persistent header, navigation drawer, hero, and footer
- **Key elements:** `#app` container swapped by router, hamburger nav menu
- **SEO:** Meta description, keywords, OpenGraph, and Twitter Card tags
- **User system nav:** Dashboard, CV Builder, Admin, Login/Logout links (conditionally visible based on auth state)
- **Script loading:** Firebase SDK (compat) → Chart.js CDN → firebase-config.js → user-system.js → cv-builder.js → scheduler.js → class-builder.js → lab-apps.js → app.js (all deferred, in order)

### app.js
- **Purpose:** SPA router, page rendering, and UI interactions
- **Key functions:** Hash-based route matching with multi-segment support (`#/dashboard/story/:id`), dynamic content injection, expandable stories, mobile touch support
- **User system integration:** Routes for login, dashboard, cv, admin, logout, schedule; wires user-system page interactivity; appends Firestore stories to projects page; loads news feed from Firestore; hides hero on CV page
  - **Scheduler routes:** `#/dashboard/scheduler/{id}` (owner admin view), `#/schedule/{id}?key={uuid}` (private speaker access, key-only)
- **PI CV view:** `buildPiExpandedHTML()` renders collapsible `<details>` sections with filter bar, citation badges, year-sorted items; `wirePiCvFilter()` handles chip-based section filtering
- **News page:** `renderNews()` renders feed layout; `buildNewsFeedCard()` creates cards with author, category badge, expandable sections, reactions, and comments; `wireNewsFeedInteractions()` hooks up social features
- **Error handling:** Render functions wrapped in try/catch with user-facing fallback messages

### firebase-config.js
- **Purpose:** Firebase initialization with project credentials
- **Graceful degradation:** If credentials are placeholder values, logs a warning and skips init — site works without Firebase

### user-system.js
- **Purpose:** All user system logic — authentication, Firestore CRUD, image processing, dashboard, story editor, admin panel
- **Key sections:**
  - **Media utilities:** Client-side image resize via Canvas API → three webp resolutions (thumb 300px, medium 800px, full 1600px); video upload (mp4/webm, up to 50 MB) direct to Firebase Storage
  - **DB operations:** CRUD for users, stories, news posts, project packages, classes (course listings), invitations, comments, reactions collections
  - **CV-to-profile sync:** `syncCVToProfile()` maps CV builder data (journals, conferences, presentations, patents) to public user profile fields with year, citations, journal metadata, and other rich fields
  - **Auth:** Login, invitation-gated registration, logout, auth state management, navigation updates
  - **Dashboard:** Profile editing (name, bio, photo, category), story list with create/edit/delete, scheduler management (create/list/delete, manage via scheduler editor)
  - **Scheduler editor:** `renderSchedulerEditor`/`wireSchedulerEditor` — admin/owner view of a scheduler using `McgheeLab.Scheduler` engine; `renderSchedulePage`/`wireSchedulePage` — private key-only speaker access
  - **Story editor:** Multi-section editor with text areas, drag-and-drop image/video upload, reorder/remove sections, live preview modal, save draft / publish / submit for review
  - **News editor:** Simplified story editor for news posts — title, category (Event/Conference/Paper/Highlight/Lab Life/Other), sections with text + media, draft/publish flow
  - **Admin panel:** Tabbed interface — user management (role changes), invitation generator (with copy link), pending story review (approve/reject), pending news review (approve/reject), course listings (add creates both `classes` + `schedules` docs with auto-generated schedule ID; edit navigates to course builder; delete cascades across participants + classFiles + Storage + schedules)
- **Exports:** All render/wire functions and Auth/DB objects on `window.McgheeLab` namespace

### cv-builder.js
- **Purpose:** Full-featured academic CV builder — data management, import/export, analytics, AI assistant
- **Key sections:**
  - **Schemas:** 11 section types (profile, education, employment, journals, conferences, presentations, patents, grants, awards, teaching, service) with typed field definitions
  - **Parsers:** BibTeX (basic + context-aware filename detection), NSF Current & Pending, NSF Biosketch, duplicate detection
  - **Generators:** LaTeX (moderncv template), BibTeX export, PDF HTML (3 templates: classic, modern, NSF)
  - **External APIs:** CrossRef (DOI auto-fill, citation counts), ORCID (public works search), Anthropic (AI writing assistant via per-user API key)
  - **State management:** `_data` object stored in Firestore `cvData/{uid}`, auto-syncs associations to user profile on every save
  - **Versioning:** Named snapshots with per-section and per-entry visibility toggles
  - **Dashboard/Analytics:** Completeness stats, section counts, Chart.js charts (publications timeline, category breakdown)
- **Render/wire pattern:** `renderCV()` returns HTML shell; `wireCV()` loads data from Firestore, populates from user profile on first load, attaches all event listeners
- **Exports:** `McgheeLab.renderCV`, `McgheeLab.wireCV`

### scheduler.js
- **Purpose:** Standalone, reusable dual-mode scheduling engine — embeddable anywhere on the site (class pages, events, conferences). Zero module state; all state passed via config object.
- **Key sections:**
  - **Unified builder layout:** `builderHTML()` / `wireBuilder()` — calendar on left + scrollable day-column time grid on right; both modes share same layout; grid has one column per selected day with date headers + sticky headers; 7am–9pm, 15-min rows
  - **Two scheduling modes:**
    - **Sessions:** Admin sets session duration (15m–2hr) via dropdown, clicks grid cells to place/remove blocks of that length per day; `sessionBlocks: [{ id, day, start, end, color }]` — one block per day
    - **Freeform:** Click+drag to paint/erase individual cells per day; `freeformCells: ['2026-06-08-0900', ...]` — granular per-cell availability
  - **`sessionBlocks` / `freeformCells` data models:** `expandSchedule()` derives days + slots from sessionBlocks (supports both `sb.day` and legacy `sb.days`), falls back to `selectedDays` + `slotDefs`, then `startDate/endDate`
  - **Three role-based views:** Admin (setup + heatmap + guest management + optimization), Guest (availability input + submission form), Public (read-only grid + confirmed guests)
  - **View normalization:** `normalizeView()` maps legacy names (`speaker`→`guest`, `student`→`public`) for backward compat
  - **Admin view switcher:** Preview as Guest or Public
  - **Pure grid renderers:** `sessionsGridHTML()`, `freeformGridHTML()` return HTML strings; sessions grid marks invalid day+slot combos as disabled
  - **Drag-to-select:** `wireFreeformDrag()` — pointer events API for guest-facing freeform availability painting
  - **Optimization:** `optimizeSchedule()` — greedy constraint-based bipartite matching
  - **Setup form:** `setupFormHTML()` + `wireSetupForm()` — mode toggle; mounts unified builder; `builderApi` provides `.getBlocks()`, `.getCells()`, `.getDays()`, `.getDuration()` getters for save
  - **Configurable guest fields:** `guestFields` array toggles Talk Summary, Discussion Questions, Presentation Materials Link; empty = bare-bones availability only
  - **Callback-based persistence:** Scheduler never touches Firestore directly; host provides `onSaveSpeaker`, `onSaveSchedule`, `onAddSpeaker`, `onDeleteSpeaker`, `onRefresh`, `onSwitchView` callbacks
- **Public API:** `McgheeLab.Scheduler.render(config)` returns HTML; `McgheeLab.Scheduler.wire(containerId, config)` attaches listeners. Also exposes: `renderGrid`, `renderSetupForm`, `wireSetupForm`, `renderBuilder`, `wireBuilder`, `renderConfirmedSpeakers`, `expandSchedule`, `optimizeSchedule`, `heatColor`, `fmtTime`, `slotLabel`

### class-builder.js
- **Purpose:** Tab-based course builder with nested sections and widgets, autosave, admin preview, and role-based views. Consumes `McgheeLab.Scheduler` for the speakers section.
- **Key sections:**
  - **Section registry (`SECTION_REG`):** Maps 9 section keys to 3 component types — `text` (textarea editor), `files` (upload/download manager), `speakers` (delegates to Scheduler)
  - **Widget registry (`WIDGET_REG`):** 7 widget types — text block, image (upload + caption), video (YouTube/Vimeo embed), link list, HTML embed, simulation (sandboxed iframe), divider
  - **Module state:** `_tabs`, `_activeTabId`, `_previewMode`, `_viewType`, `_classData`, `_speakers`, `_currentSpeaker`, `_useKeyAuth`, `_scheduleId`, `_dirty`, `_autosaveTimer`, `_fileData`
  - **Tab system:** `_tabs` array of `{ id, name, sections }` objects; tab bar UI with add/rename/delete; `switchTab()` gathers DOM content then swaps active tab
  - **Data model:** `tabs: [{ id, name, sections: [{ key, id, name, collapsed, content, storagePath, widgets: [{ kind, id, ...content }] }] }]`; sections are repeatable instances of a type; each stores its own content/name; widgets nested inside sections
  - **Repeatable sections:** Any section type can be added multiple times; no uniqueness constraint; each instance has independent name/content/collapse state
  - **Collapsible sections:** `collapsed` boolean on each section; toggle button (▶/▼) in chrome bar and readonly header; `toggleSectionCollapse()` updates DOM in-place; `.cb-collapsed` CSS class hides content
  - **Section naming:** Each section has a custom `name` (prompted on creation); double-click label to rename in admin mode; type badge shows SECTION_REG label
  - **Section type styling:** `.cb-section-type-{key}` CSS class on every section; default colored left borders per type (simulations=#4fc3f7, overview=#81c784, etc.)
  - **Per-section content:** Text sections store content in `section.content` (not `_classData`); file sections use `section.storagePath` for unique Firestore paths; `_fileData` keyed by `section.id`
  - **Migration:** `migrateLegacy()` converts old formats into tabs; `ensureSectionFields()` populates `name`, `collapsed`, `content`, `storagePath` from legacy data
  - **Preview toggle:** `_previewMode` flag; `isEditing()` helper used by all renderers; "Preview" button in header switches between editing and read-only views; preview banner shown
  - **Canvas layout:** `buildCanvasHTML()` renders tab bar + "Add Section" dropdown + sections with nested widgets; no side palettes
  - **Section renderers:** `buildSectionBlockHTML(section)` renders chrome bar with collapse toggle + collapsible wrapper containing `renderSectionBody()` + nested widgets + "Add Widget" dropdown
  - **Widget renderers:** `buildWidgetBlockHTML(widget, sectionId)` renders mini chrome bar + `renderWidgetBody()` nested inside parent section
  - **Tab management:** `addTab()`, `deleteTab()`, `renameTab()`, `switchTab()` — cannot delete last tab; rename via double-click → prompt
  - **Section management:** `addSection()` (prompts for name), `removeSection()`, `moveSection()`, `reorderSection()`, `renameSection()`, `toggleSectionCollapse()` — operate on active tab; DnD for reordering via handle
  - **Widget management:** `addWidget(sectionId, kind)`, `removeWidget()`, `moveWidget()` — up/down arrow buttons for reordering within a section
  - **Drag and Drop:** HTML5 DnD API for section reordering within canvas; handle-based activation; drop indicator between sections
  - **Autosave:** `markDirty()` sets flag + status indicator; `startAutosave()` runs 30s interval; `persistAll()` gathers content from DOM → saves `tabs` array (with all section content) to Firestore; `stopAutosave()` fires final save on leave; `beforeunload` warning
  - **Content gathering:** `gatherContentFromDOM()` reads textareas/inputs from DOM; section text via `.cb-section-text[data-section-id]`; uses `findWidgetById()` and `findSectionById()` for lookups
  - **Speakers component:** `buildSchedulerConfig()` constructs config object with ScheduleDB callbacks; delegates to `McgheeLab.Scheduler.render()` / `.wire()`; each speakers section gets unique container ID
  - **Settings modal:** Title, subtitle, semester, level, description, classDates, registrationLink fields
  - **ScheduleDB:** Firestore CRUD for `schedules`, `participants`, `classFiles` collections
  - **Default schedule seed:** BME 295C (sessions mode, Summer 2026, June 8–12, sections: overview + speakers + files)
  - **Persistence:** `tabs` array in schedule doc; `sections` array derived for backwards compat; text content stored per-section within tabs
- **Render/wire pattern:** `renderClassPage(scheduleId)` returns HTML shell; `wireClassPage(scheduleId)` loads data, migrates legacy format, builds canvas with tabs, wires DnD + autosave
- **Exports:** `McgheeLab.renderClassPage`, `McgheeLab.wireClassPage`, `McgheeLab.ScheduleDB`

### lab-apps.js
- **Purpose:** Lab Apps hub + iframe embedder — private section for authenticated lab members (non-guest)
- **Key sections:**
  - **App registry (`LAB_APPS`):** Array of app definitions with `id`, `name`, `description`, `path` (to standalone `index.html`), `icon` (SVG), `status`, and `adminOnly` flag
  - **Hub renderer (`renderLabApps`):** Auth-gated grid of app cards; filters out `adminOnly` apps for non-admin users; redirects guests to dashboard and unauthenticated to login
  - **Iframe embedder (`renderLabApp(appId)`):** Renders `<iframe>` loading the app's standalone `index.html`; breadcrumb nav above; `wireLabApp` sends auth via postMessage
  - **Auth handshake (`wireLabApp`):** Listens for `mcgheelab-app-ready` from iframe → responds with `mcgheelab-auth` containing `user` and `profile` objects; also handles `mcgheelab-app-resize` for auto-sizing
- **Apps:** Inventory Tracker, Equipment Scheduler, Lab Meeting, Admin Console (admin-only)
- **Routing:** `#/apps` (hub) and `#/apps/{appId}` (iframe embed) handled in `app.js` render/wire switches
- **Navigation:** `#nav-apps` `<li>` shown when `Auth.currentUser` exists and `role !== 'guest'`
- **Exports:** `McgheeLab.renderLabApps`, `McgheeLab.wireLabApps`, `McgheeLab.renderLabApp`, `McgheeLab.wireLabApp`, `McgheeLab.LAB_APPS`

### apps/ (standalone app directory)
- **Purpose:** Self-contained mini-applications that run independently or embedded via iframe in the main site
- **Structure:** Each app has `index.html` (standalone entry point), `app.js` (logic), `styles.css` (app-specific styles)
- **Shared modules:**
  - `apps/shared/auth-bridge.js` — `McgheeLab.AppBridge` singleton; dual-mode auth: embedded (postMessage from parent) or standalone (Firebase `onAuthStateChanged`); exposes `init()`, `onReady(fn)`, `isEmbedded()`, `getUser()`, `getProfile()`, `isAdmin()`; 5s timeout → auth wall fallback
  - `apps/shared/app-base.css` — Dark theme variables (--bg, --surface, --accent, etc.), common components (.app-card, .app-btn, .app-input, .app-badge), auth wall, embedded/standalone body classes, responsive breakpoint at 600px
- **App list:**
  - `apps/inventory/` — Inventory Tracker: supplies, equipment catalog, orders
  - `apps/equipment/` — Equipment Scheduler: calendar view, reservations, Google Calendar sync
  - `apps/meetings/` — Lab Meeting: schedule, agendas & notes, action items
  - `apps/console/` — Admin Console (admin-only): app management, user permissions, integrations, usage logs
- **Execution modes:** Embedded (`.app-embedded` class, header hidden, auth via postMessage) vs Standalone (`.app-standalone` class, header visible, auth via Firebase direct)
- **Script load order in standalone:** Firebase SDK (compat) → `../../firebase-config.js` → `../shared/auth-bridge.js` → `app.js`

### cv-styles.css
- **Purpose:** Styling for CV builder page — dark theme with gold accent (`--cv-gold`)
- **Layout:** Sidebar navigation (desktop) + bottom nav (mobile), main content area with cards
- **Responsive:** Breakpoint at 768px; mobile drawer, bottom nav bar, stacked form grids

### migrate-content.js
- **Purpose:** One-time migration of content.json → Firestore (research, projects, team)
- **Usage:** `McgheeLab.migrateContent()` in browser console

### content.json
- **Purpose:** Static site content — mission, research, projects, team, classes
- **Role in V2.0:** Serves as baseline/fallback; Firestore user stories augment the projects page

### styles.css
- **Purpose:** Public site styling, responsive layout, animations
- **Responsive strategy:** Fluid typography via `clamp()`, auto-fit grids, breakpoints at 768px (tablet) and 600px (phone)

### user-styles.css
- **Purpose:** Styling for user system pages — auth forms, dashboard, story editor, admin panel, modals
- **Key patterns:** Form groups, status badges (draft/pending/published), section blocks, image upload zones, admin tables, tab navigation

### firestore.rules / storage.rules
- **Purpose:** Firebase security rules for Firestore and Storage
- **Access model:** Role-based (admin/editor/contributor); published stories and news posts readable by all; users write own profile; 10 MB image / 50 MB video upload limit; `newsPosts` collection follows same pattern as `stories`; `cvData` collection owner read/write + admin read; `cv/` storage path for BibTeX/PDF imports; `schedules` collection public read, owner/admin write (any authenticated user can create); `participants` collection public read, admin create/delete, self-update via auth UID or invite key; `classFiles` collection public read, auth create, admin update/delete; `classes/` storage path public read, auth write, 50 MB limit

### poster/
- **Purpose:** Standalone academic poster sub-site with its own Firebase integration

## Data Flow

### Public pages
```
URL hash change → app.js router → render from content.json → inject into #app
                                 → (async) fetch Firestore published stories → append to grid
```

### User system pages
```
URL hash change → app.js router → McgheeLab.render*() returns HTML string
               → inject into #app → McgheeLab.wire*() attaches event listeners
               → user actions → Firestore reads/writes → UI updates
```

### Authentication flow
```
Admin generates invitation → shares link → student opens #/login?token=...
  → validates token → creates Firebase Auth account → creates Firestore user profile
  → marks invitation used → redirects to #/dashboard
```

### CV builder flow
```
#/cv → wireCV() loads cvData from Firestore (or creates empty with profile pre-population)
  → user edits sections → persist() saves to Firestore + syncCVToProfile() updates user profile
  → imports: BibTeX/NSF/ORCID parsed into entries → DOI auto-fill via CrossRef
  → exports: LaTeX/BibTeX/PDF generated client-side → AI assistant calls Anthropic API with user's key
  → versioning: snapshots save visibility state per section/entry → can restore/compare
```

### Story creation flow
```
Dashboard → New Story → add sections (text + images/videos) → Save Draft / Publish / Submit
  → images auto-resized client-side → uploaded to Firebase Storage at 3 resolutions
  → videos (mp4/webm) uploaded directly to Firebase Storage (50 MB limit)
  → story saved to Firestore → status based on user role privileges
  → admin reviews pending stories → approve (published) or reject (back to draft)
```

## Design Decisions

- **No frameworks:** Keeps deployment simple, no build step needed
- **Hash routing:** Works with GitHub Pages and GoDaddy static hosting
- **JSON content store:** Enables non-developers to update text/team info without touching JS
- **Firebase backend:** Decoupled from hosting provider; free tier covers lab-scale usage
- **Compat SDK:** Firebase compat libraries work with vanilla JS script tags, no bundler needed
- **Client-side image resize:** Students upload one image; Canvas API generates thumb/medium/full as webp — simpler UX than asking for multiple files
- **Invitation-based registration:** Admin controls who can register; no open signups
- **Role-based publishing:** Admin sets user role → determines if stories auto-publish or need review
- **Graceful degradation:** Site works without Firebase configured; user system features simply hidden
- **Global namespace (`McgheeLab`):** User system modules communicate via `window.McgheeLab` to avoid ES module refactoring of the existing IIFE-based app.js
