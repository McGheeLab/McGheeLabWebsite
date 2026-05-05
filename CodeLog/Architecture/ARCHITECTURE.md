# Architecture

**Version:** V3.50

## System Overview

McGheeLab website is a single-page application (SPA) using vanilla HTML, CSS, and JavaScript. It uses hash-based routing to navigate between sections without page reloads. Public site content is stored in content.json, while user-generated content (stories, profiles) lives in Firebase Firestore. Authentication is handled by Firebase Auth with invitation-based registration.

As of V3.40 the site is moving toward a **two-tier shape**: the public marketing SPA at `/` (mission, research, projects, team, classes, news, opportunities, login) and the auth-gated **RM** dashboard at `/rm/`. RM is the single home for every lab tool — the 12 standalone apps under `/apps/` and the public-site dashboard/admin/cv/guide routes are migrating into RM in three phases: **Phase A (V3.40)** stitches every existing lab app into RM via iframe-bridge wrappers and prunes the public **Lab Apps** menu; **Phase B (V3.41–V3.52)** ports each app onto the RM data contract (`api.load`/`api.save`, IndexedDB cache, `LIVE_SYNC`, `firebridge` auth gate); **Phase C (V3.53)** deletes `/apps/` and the public-site admin/dashboard surface entirely. Plan: [CodeLog/ClaudesPlan/V3.40_rm_app_migration.md](../ClaudesPlan/V3.40_rm_app_migration.md).

## Module Breakdown

### index.html
- **Purpose:** HTML shell with persistent header, navigation, hero, and footer
- **Key elements:** `#app` container swapped by router; three nav surfaces: `#desktop-nav` (inline horizontal, ≥768px), `#bottom-tabs` + `#more-sheet` (mobile tab bar, <768px), `#site-nav` drawer (legacy, hidden)
- **SEO:** Meta description, keywords, OpenGraph, and Twitter Card tags
- **User system nav:** Dashboard, CV Builder, Admin, Login/Logout links (conditionally visible based on auth state)
- **Script loading:** Firebase SDK (compat, including messaging) → Chart.js CDN → firebase-config.js → user-system.js → cv-builder.js → scheduler.js → class-builder.js → lab-apps.js → push-notifications.js → app.js (all deferred, in order); SW registration inline script at end of head
- **PWA:** Manifest link, theme-color, iOS PWA meta tags, favicon links, Microsoft Tile meta

### app.js
- **Purpose:** SPA router, page rendering, and UI interactions
- **Key functions:** Hash-based route matching with multi-segment support (`#/dashboard/story/:id`), dynamic content injection, expandable stories, mobile touch support
- **User system integration:** Routes for login, dashboard, cv, admin, logout, schedule; wires user-system page interactivity; appends Firestore stories to projects page; loads news feed from Firestore; hides hero on CV page
  - **Scheduler routes:** `#/dashboard/scheduler/{id}` (owner admin view), `#/schedule/{id}?key={uuid}` (private speaker access, key-only)
- **PI CV view:** `buildPiExpandedHTML()` renders collapsible `<details>` sections with filter bar, citation badges, year-sorted items; `wirePiCvFilter()` handles chip-based section filtering
- **News page:** `renderNews()` renders feed layout + filter-bar slot; `buildNewsFeedCard()` creates cards (now uses `buildExpandedHTML()` so team renders alongside sections); `wireNewsFeedInteractions()` hooks up social features using prefetched comment counts
  - **Filter bar:** `buildNewsFilterBar()` builds Type/Person/Time/Has-comments controls from loaded posts; `wireNewsFilters()` owns filter state and re-renders from the cached list via `applyNewsFilters()`; helpers `collectNewsPeople()` / `postInvolvesPerson()` unify author + team (author/mentor/contributors) for the Person filter
  - Comment counts prefetched once via `Promise.all(getCommentsByStory)`; stored on each post as `_commentCount` for instant has-comments filtering and badge rendering
- **Image lightbox:** `ensureLightbox()` lazily builds a single shared overlay in `<body>`; `openImageLightbox(src, alt)` opens it; `wireImageZoom(rootEl)` delegates clicks on images inside research-stories/news feeds. Supports wheel/double-click/pinch zoom and drag pan; closes on backdrop, X, or Escape
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
  - **Auth:** Login (15s timeout via Promise.race), invitation-gated registration, Google popup login (15s timeout), logout, auth state management (`_authStateResolved` flag, `onChange`/`offChange` listener subscribe/unsubscribe), navigation updates
  - **Dashboard:** Profile editing (name, bio, photo, category), story list with create/edit/delete, scheduler management (create/list/delete, manage via scheduler editor)
  - **Scheduler editor:** `renderSchedulerEditor`/`wireSchedulerEditor` — admin/owner view of a scheduler using `McgheeLab.Scheduler` engine; `renderSchedulePage`/`wireSchedulePage` — private key-only speaker access
  - **Story editor:** Multi-section editor with text areas, drag-and-drop image/video upload, reorder/remove sections, live preview modal, save draft / publish / submit for review
  - **News editor:** Simplified story editor for news posts — title, category (Event/Conference/Paper/Highlight/Lab Life/Other), cover image, Team section (author readonly, mentor dropdown, contributor chip picker — mirrors story editor), sections with text + media, draft/publish flow. Saves `team: { author, mentor, contributors }` alongside legacy `authorName`/`authorUid`/`authorPhoto` for backwards compatibility
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
  - **Custom yes/no questions:** `schedule.booleanQuestions: [{ id, text }]` — owner-defined boolean questions rendered as checkboxes in the guest Details card; answers stored as sparse map `participants/{key}.booleanAnswers: { [questionId]: true }` (only checked entries persisted, so deleted questions auto-clean). Stable `id`s preserve answers across text edits
  - **Callback-based persistence:** Scheduler never touches Firestore directly; host provides `onSaveSpeaker`, `onSaveSchedule`, `onAddSpeaker`, `onDeleteSpeaker`, `onRefresh`, `onSwitchView` callbacks
- **Public API:** `McgheeLab.Scheduler.render(config)` returns HTML; `McgheeLab.Scheduler.wire(containerId, config)` attaches listeners. Also exposes: `renderGrid`, `renderSetupForm`, `wireSetupForm`, `renderBuilder`, `wireBuilder`, `renderConfirmedSpeakers`, `expandSchedule`, `optimizeSchedule`, `heatColor`, `fmtTime`, `slotLabel`

### class-builder.js
- **Purpose:** Tab-based course builder with nested sections and widgets, autosave, admin preview, and role-based views. Consumes `McgheeLab.Scheduler` for the speakers section.
- **Key sections:**
  - **Section registry (`SECTION_REG`):** Maps 10 section keys to 4 component types — `text` (textarea editor), `files` (upload/download manager), `speakers` (delegates to Scheduler), `modules` (learning module manager)
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
  - **Persistence:** `tabs` array in schedule doc; `sections` array derived for backwards compat; text content stored per-section within tabs; `modules` array saved alongside tabs
  - **Learning modules:** `renderModulesBody()` admin view (reorder/title/file/homework/published table) and public view (numbered card links to `modules/{classId}/{htmlFile}?class={classId}`); `wireModuleEditors()` handles add/delete/reorder; `buildHomeworkDropdown()` populates from `hasDue` file sections; `gatherContentFromDOM()` reads module fields; `persistAll()` includes `modules[]`
- **Render/wire pattern:** `renderClassPage(scheduleId)` returns HTML shell; `wireClassPage(scheduleId)` loads data, migrates legacy format, builds canvas with tabs, wires DnD + autosave
- **Exports:** `McgheeLab.renderClassPage`, `McgheeLab.wireClassPage`, `McgheeLab.ScheduleDB`

### lab-apps.js
- **Purpose:** Lab Apps hub + iframe embedder — private section for authenticated lab members (non-guest)
- **Status (V3.40):** **Orphaned in the public nav.** Phase A of the RM migration removed the `Lab Apps` `<li>` entries from all three nav surfaces (drawer, desktop, mobile sheet) and dropped the `nav-apps`/`dnav-apps`/`more-apps` toggle from `Auth.updateNavigation()`. The script is still loaded by `index.html` and the `#/apps` SPA route is still registered in `app.js`, but no nav surface points at it. Phase C (V3.53) deletes the file and the route. **Apps now live under `/rm/`** — see *rm/ (ResearchManagement)* below.
- **Key sections:**
  - **App registry (`LAB_APPS`):** Array of app definitions with `id`, `name`, `description`, `path` (to standalone `index.html`), `icon` (SVG), `status`, and `adminOnly` flag
  - **Hub renderer (`renderLabApps`):** Auth-gated grid of app cards; filters out `adminOnly` apps for non-admin users; redirects guests to dashboard and unauthenticated to login
  - **Iframe embedder (`renderLabApp(appId)`):** Renders `<iframe>` loading the app's standalone `index.html`; breadcrumb nav above; `wireLabApp` sends auth via postMessage
  - **Auth handshake (`wireLabApp`):** Listens for `mcgheelab-app-ready` from iframe → responds with `mcgheelab-auth` containing `user` and `profile` objects; also handles `mcgheelab-app-resize` for auto-sizing
- **Apps:** Inventory Tracker, Equipment Scheduler, Lab Meeting, Admin Console (admin-only), Activity Tracker, The Huddle, Scheduler
- **Routing:** `#/apps` (hub) and `#/apps/{appId}` (iframe embed) handled in `app.js` render/wire switches
- **Navigation:** ~~`#nav-apps` `<li>` shown when `Auth.currentUser` exists and `role !== 'guest'`~~ — **removed in V3.40.**
- **Exports:** `McgheeLab.renderLabApps`, `McgheeLab.wireLabApps`, `McgheeLab.renderLabApp`, `McgheeLab.wireLabApp`, `McgheeLab.LAB_APPS`

### apps/ (standalone app directory)
- **Purpose:** Self-contained mini-applications that run independently or embedded via iframe in the main site
- **Structure:** Each app has `index.html` (standalone entry point), `app.js` (logic), `styles.css` (app-specific styles)
- **Shared modules:**
  - `apps/shared/auth-bridge.js` — `McgheeLab.AppBridge` singleton; dual-mode auth: embedded (postMessage from parent) or standalone (Firebase `onAuthStateChanged`); exposes `init()`, `onReady(fn)`, `isEmbedded()`, `getUser()`, `getProfile()`, `isAdmin()`; standalone mode uses 2s grace period before treating null auth as sign-out (allows Firebase persistence to restore session from IndexedDB); embedded mode 8s timeout → auth wall fallback; recovery: if auth wall is showing and valid user arrives later, triggers `location.reload()` for clean restart; parent (`lab-apps.js`) also forwards auth to iframes via `Auth.onChange` listener for event-driven delivery
  - `apps/shared/app-base.css` — Dark theme variables (--bg, --surface, --accent, etc.), common components (.app-card, .app-btn, .app-input, .app-badge), auth wall, embedded/standalone body classes, responsive breakpoint at 600px; mobile shell styles (top bar, bottom bar, hamburger menu, filter dropdown, back button) active at ≤700px
  - `apps/shared/mobile-shell.js` — `McgheeLab.MobileShell` singleton; injects consistent phone navigation on all lab apps (except chat which handles its own); `configure({ appId, title })` to activate; creates sticky top bar (title + user avatar + hamburger), fixed bottom bar (5 app quick-nav icons + back arrow FAB); hamburger opens slide-in menu with all app links; auto-injects/removes on window resize; `setBackVisible(bool)` API for sub-page navigation
  - `apps/shared/calendar-service.js` — `McgheeLab.CalendarService` singleton; centralized multi-provider calendar integration (Google OAuth, Microsoft MSAL, Apple/ICS). Config persisted in `userSettings/{uid}.calendar`; OAuth tokens session-lived via shared `sessionStorage` keys. Exposes `init()`, `getEventsForDate()`, `connectGoogle()`, `disconnectGoogle()`, `connectOutlook()`, `disconnectOutlook()`, `importICSFile()`, `fetchAll()`, `onChange()`, `isConnected()`, `saveConfig()`, `dismissEvent()`, `restoreDismissed()`, `setEventStatus()`, `getEventStatus()`. ICS parsing, CORS proxy fallback chain (Firebase Cloud Function proxy first), configurable auto-refresh interval, per-event dismissal and busy-available status. Loaded by settings, activity tracker, huddle, and scheduler apps
  - `apps/shared/schedule-utils.js` — `McgheeLab.ScheduleUtils` singleton; pure time/week utility functions shared across huddle and scheduler: `getWeekDays()`, `fmtTime()`, `timeToSlot()`, `slotToTime()`, `timeLabels()`, `parseCalTimeToHHMM()`, `localDateStr()`, `todayStr()`, `getUserColor()`, `ZOOM_LEVELS`, `USER_COLORS`. No state or side effects
  - `apps/shared/schedule-service.js` — `McgheeLab.ScheduleService` singleton; schedule data layer managing Firestore subscriptions to `huddleScheduleTemplates` and `huddleScheduleOverrides`, plus `scheduleCustomEvents`. Exposes `init()`, `resolveScheduleForUser()` (template + override + custom event + calendar injection), `resolveAvailabilityOverlap()`, `saveScheduleTemplate()`, `addScheduleOverride()`, `deleteScheduleOverride()`, `saveCustomEvent()`, `deleteCustomEvent()`, `getLayerConfig()`, `saveLayerConfig()`, `setWeekOffset()`, `onChange()`. Constants: `UNAVAIL_REASONS`, `REASON_COLORS`, `MODE_COLORS`, `MODE_LABELS`. Loaded by scheduler and huddle apps
- **App list:**
  - ~~`apps/inventory/`~~ — **deleted in V3.43.** Was a 48-line stub; the real inventory management system is at [rm/pages/inventory.html](../../rm/pages/inventory.html) (8 tabs, 30+ subcategories, multi-location stock, LIVE_SYNC).
  - `apps/equipment/` — Equipment Scheduler: full booking system for shared lab instruments. Tab layout (Calendar, My Bookings, Admin). Weekly CSS Grid calendar (7am-9pm, 30-min slots, 7 days) and monthly dot-grid view with per-device filtering dropdown. Priority color coding (normal/high/urgent/maintenance) with customizable colors. Booking modal with conflict detection, duration constraints, and advance-day limits. Training/permission system: admin defines certification types, assigns per user, devices require specific certs; co-operator requirement forces lower-category users (undergrads) to select a grad+ co-operator. Admin panels: device CRUD, training checkbox table, settings. Google Calendar push-sync via Google Identity Services OAuth (admin-driven, per-device calendar IDs). Real-time via Firestore `onSnapshot`. Data: `equipment/{equipmentId}` (catalog), `equipmentBookings/{bookingId}` (reservations), `equipmentTraining/{uid}` (certs), `equipmentSettings/config` (singleton)
  - `apps/meetings/` — Lab Meeting: weekly meeting management with fixed-rotation presentation scheduling, collaborative agenda builder (any member adds items), shared notes, action item tracking with cross-meeting carry-over, and post-presentation cross-pollination signals (reaction chips: interesting/questions/collaborate/relevant). Sidebar+main layout with 5 sections: Next Meeting, Schedule, Archive, My Items, Settings. Admin generates semester meetings from config (day/time/skip dates/rotation order). Data: `meetings/{meetingId}` (embedded agendaItems[], actionItems[], feedback[] arrays), `meetingConfig/settings` (rotation, semester config). Real-time via Firestore `onSnapshot`
  - ~~`apps/console/`~~ — **deleted in V3.42.** Was a 65-line stub; the four promised admin functions (app management, user permissions, integrations, usage logs) live elsewhere in RM (nav gating in [rm/js/nav.js](../../rm/js/nav.js), future `rm/pages/admin.html`, [rm/pages/settings.html](../../rm/pages/settings.html), [rm/pages/api-usage.html](../../rm/pages/api-usage.html)).
  - `apps/activity-tracker/` — Activity Tracker: daily activity logging with hierarchical categories, ML categorization (Naive Bayes), AI categorization (Anthropic API), milestone tracking, voice input, Chart.js analytics dashboard. Privacy: strictly owner-only Firestore rules. Data: `trackerData/{userId}` (settings, categories, ML model) + `trackerEntries/{userId}/entries/{entryId}` subcollection (task entries with date, categoryPath, duration, milestone, source)
  - `apps/huddle/` — The Huddle: community-driven weekly planning board. Lab members post planned protocols/tasks for the week, others sign up to watch or join. Real-time feed via Firestore `onSnapshot`, week navigation, check-in prompts, protocol linking, status management (completed/cancelled/delayed/skipped). **The Rundown:** non-timeframe task list per week with admin-configurable categories and project associations; join-request workflow where others request to shadow/help, owner accepts and schedules onto the huddle calendar with availability overlap detection. **Lab Schedule:** recurring weekly availability template with per-week overrides; blocks typed as available/unavailable with reasons and rigid/flexible rigidity; Team Availability Gantt view shows all members' schedules per day. Data: `huddlePlans`, `huddleCheckins`, `huddleProtocols`, `huddleRundown` (weekly tasks with joinRequests array), `huddleConfig/settings` (admin-managed categories), `huddleScheduleTemplates/{userId}` (recurring weekly blocks), `huddleScheduleOverrides` (per-week deviations)
  - `apps/scheduler/` — Scheduler: standalone scheduling app moved from dashboard. List view with create/manage/delete; editor view using `McgheeLab.Scheduler` engine with admin/guest/public view switching, guest management, session builder, freeform availability. Self-contained ScheduleDB for Firestore CRUD. Loads `scheduler.js` via script tag. Data: reuses existing `schedules` and `participants` Firestore collections
  - `apps/chat/` — Lab Chat: real-time messaging with channels, DMs, threads, reactions, @mentions, read receipts, and Google Drive file sharing. Desktop: three-panel layout (sidebar + message feed + optional thread panel). Mobile (≤700px): conversation-list-first design with view state machine (`_mobileView`: list/conversation/files); conversation list shows all subscribed channels + DMs with preview/badges; filter dropdown (newest/active/unread/alpha); conversation view replaces sidebar with stats bar (readers/search/files); files view groups channel attachments by type; bottom bar with 5 app quick-nav icons + back arrow FAB; hamburger menu for browse/DM/contacts/search/settings. Subscription-based notifications: all channels visible, users subscribe for alerts. Admin-defined channel categories with channel directory browser. User-organized sidebar with draggable custom groups. Google Drive integration via Google Identity Services OAuth for file uploads to shared lab folder. Browser notifications for @mentions and DMs. Data: `chatConfig/settings` (categories, Drive config), `chatChannels/{channelId}` (metadata + denormalized lastMessage), `chatMessages/{messageId}` (messages with reactions map, readBy array, thread fields), `chatReadState/{uid_channelId}` (per-user read tracking), `chatUserMeta/{uid}` (subscriptions, sidebar layout, prefs)
- **Execution modes:** Embedded (`.app-embedded` class, header hidden, auth via postMessage) vs Standalone (`.app-standalone` class, header visible, auth via Firebase direct)
- **Script load order in standalone:** Firebase SDK (compat) → `../../firebase-config.js` → `../shared/auth-bridge.js` → `../shared/mobile-shell.js` → `../shared/calendar-service.js` → `app.js` (chat app omits mobile-shell.js and calendar-service.js)
- **Status (V3.40):** All 12 apps are reachable through the new RM nav via iframe-bridge wrappers in [rm/pages/app-*.html](../../rm/pages/) — see *rm/* below. The standalone `/apps/<name>/` URLs still work as a fallback during the multi-version migration. Phase B (V3.41–V3.52) replaces each iframe wrapper with a native RM page; Phase C (V3.53) deletes `/apps/` entirely.

### rm/ (ResearchManagement)
- **Purpose:** Auth-gated lab dashboard at `mcgheelab.com/rm/`. As of V3.40 this is the consolidating home for every lab tool — the 12 lab apps (currently iframe-bridged) plus the migrated public-site dashboard/admin/cv/guide editors (in progress, V3.43–V3.45).
- **Source of truth:** This `/rm/` tree is the canonical RM source — edit here directly, not the sibling `ResearchManagement/` repo. Detailed RM-internal architecture lives in [rm/CLAUDE.md](../../rm/CLAUDE.md).
- **Data layer:** Every Firestore path is registered in [rm/js/api-routes.js](../../rm/js/api-routes.js); call sites use `api.load(path)` / `api.save(path, data)` from [rm/js/util.js](../../rm/js/util.js). The adapter at [rm/js/api-firestore-adapter.js](../../rm/js/api-firestore-adapter.js) routes to either `userData/{uid}/<subcollection>` (per-user, `scope: 'user'`) or a top-level lab collection (`scope: 'lab'`, admin-write). IndexedDB cache via [rm/js/local-cache.js](../../rm/js/local-cache.js) with smart `MAX(updatedAt)` revalidation.
- **Auth gate:** [rm/js/firebase-bridge.js](../../rm/js/firebase-bridge.js) — `firebridge.gateSignedIn()` / `firebridge.gateAdmin('reason')` / `firebridge.whenAuthResolved()`. Anyone can sign in via Google but profile-bootstrap creates `users/{uid}` as `role: 'guest'`; `firestore.rules` `isLabMember()` requires `role != 'guest'`; firebridge renders a full-page pending-access overlay until admin promotes them. The `#dnav-rm` link in the public-site nav appears only after sign-in (regardless of role).
- **Live sync:** [rm/js/live-sync-helper.js](../../rm/js/live-sync-helper.js) — `LIVE_SYNC.attach({paths, refresh, tag})` debounces remote updates, suppresses post-save blink, deduplicates subscriptions across pages.
- **Top nav (V3.40 layout):** Six groups in [rm/js/nav.js](../../rm/js/nav.js): **Dashboard** | **Activity** (Tracker, Overview, Calendar, Email, Tasks, Sharing, Year) | **Research** (Projects, Library, Comments, Papers, Teaching, Service) | **Operations** _gate: lab-member_ (Chat, Huddle, Meetings, Scheduler, Equipment) | **Lab Admin** _gate: lab-member_ (Compliance, Chemical Safety, Inventory, Lab Members, Important People, Career & Tenure, Procurement, Purchase Requests, Grant Accounts, Budget, Analytics, Travel) | **Settings** _gate: lab-member_ (Profile, Settings, CV Overview, CV Editor, Member Activity _gate: admin_).
- **Iframe-bridge tier (Phase A only):** [rm/pages/app-chat.html](../../rm/pages/app-chat.html), [app-equipment.html](../../rm/pages/app-equipment.html), [app-huddle.html](../../rm/pages/app-huddle.html), [app-scheduler.html](../../rm/pages/app-scheduler.html). Each loads the corresponding `/apps/<name>/` in an iframe, runs `auth-bridge.js` in embedded mode, and forwards `{user, profile}` via postMessage on the existing `mcgheelab-app-ready` → `mcgheelab-auth` handshake. Same-origin Firebase IndexedDB persistence carries the auth into the iframe automatically; the postMessage just populates `auth-bridge.js`'s `_user`/`_profile`. Phase B replaces each wrapper with a native RM page; the wrapper file becomes a `<meta http-equiv="refresh">` redirect to preserve bookmarks, and is deleted entirely in Phase C. The proven activity-tracker bridge at [rm/pages/activity-tracker.html](../../rm/pages/activity-tracker.html) is the template (and is itself rewritten as a native renderer in V3.49). [rm/pages/app-meetings.html](../../rm/pages/app-meetings.html) was the wrapper; V3.41 ported meetings natively and reduced it to a `<meta refresh>` redirect.
- **Native ports (Phase B, in progress):**
  - **V3.41 — Lab Meeting:** [rm/pages/meetings.html](../../rm/pages/meetings.html) + [rm/js/meetings.js](../../rm/js/meetings.js) + [rm/css/meetings.css](../../rm/css/meetings.css). Five-section sidebar (Next Meeting, Schedule, Archive, My Items, Settings); admins drag-and-drop presenter assignment, generate semester meetings from config, manage skip weeks and meeting-admin allowlist. Live-syncs `meetings/list.json`, `meetings/config.json`, `lab/users.json` via `LIVE_SYNC.attach`; surgical Firestore writes via `firebridge.db()` with `_live.suppressUntil` echo guard mirror the [rm/js/receipts.js](../../rm/js/receipts.js) pattern. Routes registered in [rm/js/api-routes.js](../../rm/js/api-routes.js).
  - **V3.44 — Procurement (greenfield):** [rm/pages/procurement.html](../../rm/pages/procurement.html) + [rm/js/procurement.js](../../rm/js/procurement.js) + [rm/css/procurement.css](../../rm/css/procurement.css). Single page covers the full purchase pipeline (request → approve → order with PO upload → receive from open-orders list → place at a location → auto-create inventory item). Tabs gated by role; surgical Firestore writes mirror the meetings pattern; placement creates an `inventory/{id}` doc with `kind: 'item'` and back-references the ticket. Stores PO + receipt uploads under `procurement/{ticketId}/{kind}-{ts}-{name}`. New collection `procurementTickets` registered as the route `procurement/tickets.json` (lab-scope, wrapKey `tickets`, SHORT cache); firestore.rules grants `isLabMember()` read/create/update with delete admin-only. Storage rule for `procurement/{docId}/**` widened to accept image content-types alongside PDF (phone-photo receipts).
  - **V3.46 — Compliance submit flow:** [rm/js/compliance.js](../../rm/js/compliance.js)'s Student Training tab gained an end-to-end student-submission path. Page-header button is now contextual: `+ Add Protocol` on IRB/IACUC tabs (admin-only), `+ Submit Certificate` on Training tab (everyone). New `openSubmitCertModal()` builds a file-upload modal (type/title/dates/cert) that writes to `compliance/{uid}/{docId}/<file>` in Storage (existing rule, no widening) and `complianceSubmissions` in Firestore (existing rule). Non-admin Training reads run `where('submittedBy','==',uid)` to satisfy the per-doc read rule; admin reads use `firebridge.getAll`. With this in place, `apps/compliance/` was deleted.
  - **V3.47 — Scheduler subset (My Schedulers):** [rm/pages/scheduler.html](../../rm/pages/scheduler.html) + [rm/js/scheduler.js](../../rm/js/scheduler.js) + [rm/css/scheduler.css](../../rm/css/scheduler.css). Scheduler (create + manage shareable scheduler links) ports natively; the editor view mounts the existing stateless engine at [/scheduler.js](../../scheduler.js) (same engine used by the public-site `#/dashboard/scheduler` editor). The host page provides `onSaveSchedule` / `onSaveSpeaker` / `onAddSpeaker` / `onDeleteSpeaker` / `onRefresh` / `onSwitchView` config callbacks routed to surgical writes via `firebridge.db()`. List view uses `api.load('scheduler/list.json')` + `LIVE_SYNC` (cross-tab creates / deletes update). My Schedule tab (calendar layers, ScheduleService, CalendarService Google OAuth) is deferred to V3.51 alongside the equipment OAuth refactor; standalone `/apps/scheduler/` URL still resolves until then. Phase A wrapper [rm/pages/app-scheduler.html](../../rm/pages/app-scheduler.html) is now a `<meta refresh>` redirect.
  - **V3.50 — The Huddle native (subset):** [rm/pages/huddle.html](../../rm/pages/huddle.html) replaces the V3.40 iframe wrapper. [rm/js/huddle.js](../../rm/js/huddle.js) (2,918 LOC, near-verbatim lift from `/apps/huddle/app.js`) covers the Plan feed (with drag-to-create on the time grid), Help requests, the Rundown (non-timeframe weekly tasks with join-request workflow + admin-configurable categories), and per-user huddle settings. The Lab Schedule view (Team Availability Gantt + recurring availability templates) gracefully degrades — its `McgheeLab.ScheduleService?.resolveScheduleForUser` and `McgheeLab.CalendarService?.getEventsForDate` calls are all optional-chained, so the section just shows empty until V3.51 brings those services into RM via the OAuth refactor. Bootstrap follows the standard RM contract; `notifyResize()` patched to no-op safely without `AppBridge`. Page styles at [rm/css/huddle.css](../../rm/css/huddle.css) (full lift of `/apps/huddle/styles.css` plus CSS-var aliases header). No firestore.rules changes — all `huddle*` collections already covered. Phase A wrapper [rm/pages/app-huddle.html](../../rm/pages/app-huddle.html) is now a `<meta refresh>` redirect.
  - **V3.49 — Activity Tracker native:** [rm/pages/activity-tracker.html](../../rm/pages/activity-tracker.html) replaces the V3.40 iframe wrapper. [rm/js/activity-tracker.js](../../rm/js/activity-tracker.js) (2,123 LOC, near-verbatim lift) covers daily logging + hierarchical category tree (synced from RM via the new [rm/js/rm-categories.js](../../rm/js/rm-categories.js) bridge, copied from `/apps/shared/`) + ML categorization (client-side Naive Bayes) + Anthropic API categorization (`users/{uid}.anthropicKey`) + Web Speech voice input + Huddle plan integration + weekly analytics with Chart.js (loaded as global UMD via CDN). Bootstrap is the standard RM contract (`firebridge.gateSignedIn` → `whenAuthResolved` → `loadData` → `render`); MobileShell calls stay optional-chained so they no-op. Calendar Integration (CalendarService Google OAuth) deferred to V3.51 — the calendar-suggest panel calls `McgheeLab.CalendarService?.getEventsForDate(date)` so it just stays empty without the service. Standalone `/apps/activity-tracker/` URL still resolves as a fallback until V3.51 deletes the directory. Page styles at [rm/css/activity-tracker.css](../../rm/css/activity-tracker.css) (full lift of `/apps/activity-tracker/styles.css` plus CSS-var aliases header). No firestore.rules changes — `trackerData/{userId}` (owner-only, line 331) and `trackerEntries/{userId}/entries/{entryId}` (owner-only, line 337) already in place.
  - **V3.48 — Settings: Profile + Notifications tabs:** [rm/js/settings.js](../../rm/js/settings.js) grew Profile + Notifications tabs at the front of the existing connection-registry tab bar. Profile reads/writes `users/{uid}` (`name`, `bio`, `shareActivity`); Notifications reads/writes `userSettings/{uid}` (master toggle, 6 per-app push toggles, quiet hours) — same nested schema the Cloud Function notification triggers consume. New page-scoped stylesheet [rm/css/settings.css](../../rm/css/settings.css) for the iOS-style toggle switch + status pills. Surgical Firestore writes via `firebridge.db()` with `set(..., { merge: true })`. No firestore.rules changes (both paths already covered: `users/{uid}` line 96, `userSettings/{uid}` line 85). Calendar Integration + admin diagnostics stay in `/apps/settings/` until V3.51 sunsets the directory alongside the equipment OAuth refactor.
- **Production deploy:** Cyberduck FTP the McGheeLabWebsite repo to godaddy — the `/rm/` subdir lands at `mcgheelab.com/rm/`. No build step. Firebase rules / indexes / Cloud Functions deploy from the McGheeLabWebsite repo root via `firebase deploy --only ...`.

### modules/ (learning module pages)
- **Purpose:** Standalone full-page HTML lesson files with auto-navigating class-specific headers. Each module is a self-contained page that loads outside the SPA.
- **Structure:** `modules/{classId}/` directories contain lesson HTML files; `modules/shared/` contains the header component; `modules/_template.html` is the starter template
- **Shared modules:**
  - `modules/shared/module-header.js` — `McgheeLab.ModuleHeader` singleton; reads `?class={scheduleId}` URL param; fetches `schedules/{classId}` from Firestore; finds current module by filename match; builds header with back link, progress indicator, title, prev/next nav, homework button; graceful degradation on error
  - `modules/shared/module-header.css` — Sticky header bar with dark theme variables matching `app-base.css`; three-zone layout (back link | center title + progress | nav buttons); responsive stacking at 600px
- **Script load order:** Firebase SDK (app + firestore compat only) → `../../firebase-config.js` → `../shared/module-header.js`
- **Data model:** Modules registered as `modules[]` array on `schedules/{classId}` Firestore doc: `{ id, title, htmlFile, order, homeworkFileId, published }`
- **Navigation:** Links from class page carry `?class=` param; prev/next links are sibling files in same directory with `?class=` preserved

### functions/ (Firebase Cloud Functions)
- **Purpose:** Server-side push notification pipeline — Firestore-triggered Cloud Functions that send FCM messages to lab members when events occur
- **Runtime:** Node.js 20, Firebase Cloud Functions v2 (2nd gen)
- **Entry point:** `functions/index.js` — initializes Firebase Admin SDK, exports 6 Cloud Functions
- **Helpers:**
  - `functions/helpers/notify.js` — `sendToUsers(db, messaging, userIds, notif, appKey)`: checks `userSettings/{uid}` for master + per-app notification toggles, fetches tokens from `users/{uid}/pushTokens`, sends via `messaging.sendEach()`, auto-deletes stale tokens on send failure
  - `functions/helpers/users.js` — `sendToAllMembers(db, messaging, notif, appKey, excludeUids)`: queries all `users` docs, filters excludes, delegates to `sendToUsers`
- **Functions:**
  - `chat.js` → `onChatMessageCreate`: Firestore trigger on `chatMessages` create; reads channel info, queries `chatUserMeta` for subscribers; respects muted channels and mentionsOnly prefs; routes DMs via `dmChannelIds`
  - `huddle.js` → `onHuddlePlanUpdate`: detects new joiners/watchers (notifies owner) and status changes (notifies participants); `onHelpRequestCreate`: broadcasts to all members; `onHelpRequestUpdate`: notifies owner on new response
  - `equipment.js` → `onEquipmentBookingCreate`: notifies equipment managers on pending-approval bookings; `onEquipmentBookingUpdate`: notifies booker on confirmed/displaced status changes
- **Deployment:** `firebase deploy --only functions` (config in `firebase.json`)
- **Notification payload:** `{ notification: { title, body }, data: { title, body, url, tag }, webpush: { fcmOptions: { link } } }` — consumed by `firebase-messaging-sw.js`

### cv-styles.css
- **Purpose:** Styling for CV builder page — dark theme with gold accent (`--cv-gold`)
- **Layout:** Sidebar navigation (desktop) + bottom nav (mobile), main content area with cards
- **Responsive:** Breakpoint at 768px; mobile drawer, bottom nav bar, stacked form grids

### migrate-content.js
- **Purpose:** One-time migration of content.json → Firestore (research, projects, team)
- **Usage:** `McgheeLab.migrateContent()` in browser console

### scripts/slack_export.py
- **Purpose:** One-time Slack → Lab Chat history export run locally with admin Firebase credentials and a workspace-owner Slack user OAuth token. Built for the Slack-off-ramp transition; runs once (idempotent) per workspace, not as a live mirror
- **Entry point:** `python3 scripts/slack_export.py [--dry-run] [--channels …] [--skip-files] [--skip-dms]`
- **Dependencies:** `slack_sdk`, `firebase-admin`, `python-dotenv`, `requests` (see `scripts/requirements.txt`)
- **Config:** `scripts/.env` (template at `scripts/.env.example`); env vars `SLACK_USER_TOKEN`, `FIREBASE_SA_PATH`, `FIREBASE_PROJECT_ID`, `FIREBASE_BUCKET`, `IMPORTER_UID`. Both `.env` and the resume-state checkpoint `.slack_export_checkpoint.json` are gitignored
- **Schema additions** to existing Lab Chat collections:
  - `chatChannels/slack_{slackId}`: adds `importedFromSlack: true`, `slackChannelId`. Channels grouped under new `Slack archive` category appended to `chatConfig/settings.categories`
  - `chatMessages/{auto}`: adds `importedFromSlack: true`, `slackTs`, `slackChannelId`, `importedBy`. Idempotency check is a `where slackChannelId == X and slackTs == Y` query before each write
  - `users/slack_{slackId}` ghost docs for non-member Slack users: `imported: true`, `disabled: true`, `role: 'guest'` — gives messages a valid `authorUid` without enabling sign-in
- **Pipeline:** `fetch_all_users` → `fetch_all_channels` → `build_user_map` (email match against existing users, ghost-create otherwise) → for each channel: `ensure_channel_doc` → `fetch_history` (paginated, oldest→newest) → pass-1 writes top-level messages, pass-2 fetches `conversations.replies` for threads and writes with resolved `threadParentId`
- **Format conversion** (in `convert_text`): Slack `<@U…>` mentions resolve to `@displayname` and append to `mentions: [uid]`; `<#C…|name>` → `#name`; `<url|label>` → `label (url)`; `<!channel>`/`<!here>`/`<!everyone>` preserved as plain `@name` text but `mentionsChannel` forced false to suppress retroactive notification storms
- **Files:** downloaded from `url_private_download` with bearer auth, re-uploaded to Storage at `chat/imported/{slackChannelId}/{slackTs}_{name}` (made public to match other chat files); >50 MB skipped to honor `storage.rules` limit
- **Rate limiting & resume:** sleeps between Tier 3 calls and on `Retry-After` 429s; `.slack_export_checkpoint.json` records `channels_done` so re-runs skip completed channels (per-message dedup is via the `slackTs` query)
- **UI side:** `apps/chat/app.js` `renderMessageHTML()` adds a `chat-badge-imported` "from Slack" pill next to the timestamp when `msg.importedFromSlack === true`

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
- **Access model:** Role-based (admin/editor/contributor); published stories and news posts readable by all; users write own profile; 10 MB image / 50 MB video upload limit; `newsPosts` collection follows same pattern as `stories`; `cvData` collection owner read/write + admin read; `cv/` storage path for BibTeX/PDF imports; `schedules` collection public read, owner/admin write (any authenticated user can create); `participants` collection public read, admin create/delete, self-update via auth UID or invite key; `classFiles` collection public read, auth create, admin update/delete; `classes/` storage path public read, auth write, 50 MB limit; `trackerData/{userId}` and `trackerEntries/{userId}/entries/{entryId}` strictly owner-only (no admin access) for activity tracker privacy; `meetings` collection authenticated read/create/update, admin-only delete; `meetingConfig` collection authenticated read, admin-only write; `equipment` collection authenticated read, admin-only write; `equipmentBookings` collection authenticated read/create, owner or admin update/delete; `equipmentTraining` collection authenticated read, admin-only write; `equipmentSettings` collection authenticated read, admin-only write; `chatConfig` collection authenticated read, admin-only write; `chatChannels` collection authenticated read/create/update, admin-only delete; `chatMessages` collection authenticated read/create, authenticated update (for reactions/read receipts), admin-only delete; `chatReadState` collection authenticated read/write; `chatUserMeta/{uid}` strictly owner-only

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

### Activity tracker flow
```
#/apps/activity-tracker → AppBridge auth → load trackerData/{userId} + entries subcollection
  → user adds tasks (text/voice) → duration auto-parsed → saved to entries subcollection
  → manual category assignment → trains ML (Naive Bayes word weights) → saves mlModel to trackerData
  → AI categorize (Anthropic API) → human approval → trains ML further
  → analytics: Chart.js charts from entries date-range queries
  → privacy: all Firestore rules strictly owner-only, no admin read
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

## PWA Architecture

### Service Workers
Two separate service workers coexist:
- **`sw.js`** — Caching service worker. Precaches shell (core HTML/CSS/JS) and all 8 lab app files on install. Runtime strategies: stale-while-revalidate (shell), cache-first (images/videos), network-first (CDN), network-only (Firebase API). Versioned caches enable clean updates.
- **`firebase-messaging-sw.js`** — FCM push notification handler. Receives background push messages, shows system notifications with vibration and desktop persistence, manages app icon badge counts via IndexedDB, handles notification clicks to navigate to relevant pages.

### Push Notification Flow
```
User grants permission → McgheePush.requestPermission(userId)
  → browser requests FCM token from Google → token returned
  → token stored in Firestore: users/{uid}/pushTokens/{token}
  → backend (Cloud Functions or admin) sends push via FCM Admin SDK
  → if app in foreground: onMessage callback → in-app toast
  → if app in background: firebase-messaging-sw.js → system notification
      → vibrate: [200, 100, 200] (Android)
      → requireInteraction: true (desktop — persists in tray)
      → tag: server-set or unique per message
      → badge count incremented via IndexedDB + Badging API
  → on notification click: clear badge, navigate to target URL
  → on app focus/visibility: clear badge via McgheePush.clearBadge()
```

### Push Permission Strategy
- **Standalone (installed PWA):** Native browser permission dialog fires proactively 1.5s after first auth resolve. `localStorage` flag `mcgheelab-push-prompted` prevents re-prompting.
- **Non-standalone (browser):** Passive "Enable notifications?" banner shown on Lab Apps hub page (`#/apps`). User must explicitly tap "Turn on".

### Badge Count Architecture
- **IndexedDB store:** `mcgheelab-badge` → key `count` — shared between service worker and main thread
- **Increment:** Service worker increments on each background push via `navigator.setAppBadge(count)`
- **Clear:** Main thread clears on `visibilitychange`/`focus` events and on initial load; service worker clears on `notificationclick`
- **Platform support:** Android Chrome PWA + desktop Chrome/Edge. Not supported on iOS.

### Installability
- **Android Chrome:** `beforeinstallprompt` event captured → custom "Install" button on apps hub
- **iOS Safari:** Detected via user agent → instructional banner ("Tap Share → Add to Home Screen")
- **Standalone mode:** `display-mode: standalone` CSS media query adjusts safe-area padding

### New Files
- `manifest.json` — Web app manifest (name, icons, shortcuts, display mode)
- `sw.js` — Caching service worker
- `firebase-messaging-sw.js` — Push notification service worker
- `push-notifications.js` — Client-side push permission/token management (`McgheePush` global)
- `icons/` — 13 icon PNGs at various sizes + maskable variant
- `favicon.ico` — Root favicon
