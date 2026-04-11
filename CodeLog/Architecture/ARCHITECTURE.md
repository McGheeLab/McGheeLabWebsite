# Architecture

**Version:** V3.31

## System Overview

McGheeLab website is a single-page application (SPA) using vanilla HTML, CSS, and JavaScript. It uses hash-based routing to navigate between sections without page reloads. Public site content is stored in content.json, while user-generated content (stories, profiles) lives in Firebase Firestore. Authentication is handled by Firebase Auth with invitation-based registration.

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
- **Key sections:**
  - **App registry (`LAB_APPS`):** Array of app definitions with `id`, `name`, `description`, `path` (to standalone `index.html`), `icon` (SVG), `status`, and `adminOnly` flag
  - **Hub renderer (`renderLabApps`):** Auth-gated grid of app cards; filters out `adminOnly` apps for non-admin users; redirects guests to dashboard and unauthenticated to login
  - **Iframe embedder (`renderLabApp(appId)`):** Renders `<iframe>` loading the app's standalone `index.html`; breadcrumb nav above; `wireLabApp` sends auth via postMessage
  - **Auth handshake (`wireLabApp`):** Listens for `mcgheelab-app-ready` from iframe → responds with `mcgheelab-auth` containing `user` and `profile` objects; also handles `mcgheelab-app-resize` for auto-sizing
- **Apps:** Inventory Tracker, Equipment Scheduler, Lab Meeting, Admin Console (admin-only), Activity Tracker, The Huddle, Scheduler
- **Routing:** `#/apps` (hub) and `#/apps/{appId}` (iframe embed) handled in `app.js` render/wire switches
- **Navigation:** `#nav-apps` `<li>` shown when `Auth.currentUser` exists and `role !== 'guest'`
- **Exports:** `McgheeLab.renderLabApps`, `McgheeLab.wireLabApps`, `McgheeLab.renderLabApp`, `McgheeLab.wireLabApp`, `McgheeLab.LAB_APPS`

### apps/ (standalone app directory)
- **Purpose:** Self-contained mini-applications that run independently or embedded via iframe in the main site
- **Structure:** Each app has `index.html` (standalone entry point), `app.js` (logic), `styles.css` (app-specific styles)
- **Shared modules:**
  - `apps/shared/auth-bridge.js` — `McgheeLab.AppBridge` singleton; dual-mode auth: embedded (postMessage from parent) or standalone (Firebase `onAuthStateChanged`); exposes `init()`, `onReady(fn)`, `isEmbedded()`, `getUser()`, `getProfile()`, `isAdmin()`; 5s timeout → auth wall fallback
  - `apps/shared/app-base.css` — Dark theme variables (--bg, --surface, --accent, etc.), common components (.app-card, .app-btn, .app-input, .app-badge), auth wall, embedded/standalone body classes, responsive breakpoint at 600px; mobile shell styles (top bar, bottom bar, hamburger menu, filter dropdown, back button) active at ≤700px
  - `apps/shared/mobile-shell.js` — `McgheeLab.MobileShell` singleton; injects consistent phone navigation on all lab apps (except chat which handles its own); `configure({ appId, title })` to activate; creates sticky top bar (title + user avatar + hamburger), fixed bottom bar (5 app quick-nav icons + back arrow FAB); hamburger opens slide-in menu with all app links; auto-injects/removes on window resize; `setBackVisible(bool)` API for sub-page navigation
  - `apps/shared/calendar-service.js` — `McgheeLab.CalendarService` singleton; centralized multi-provider calendar integration (Google OAuth, Microsoft MSAL, Apple/ICS). Config persisted in `userSettings/{uid}.calendar`; OAuth tokens session-lived via shared `sessionStorage` keys. Exposes `init()`, `getEventsForDate()`, `connectGoogle()`, `disconnectGoogle()`, `connectOutlook()`, `disconnectOutlook()`, `importICSFile()`, `fetchAll()`, `onChange()`, `isConnected()`, `saveConfig()`. ICS parsing, CORS proxy fallback chain, configurable auto-refresh interval. Loaded by settings, activity tracker, and huddle apps
- **App list:**
  - `apps/inventory/` — Inventory Tracker: supplies, equipment catalog, orders
  - `apps/equipment/` — Equipment Scheduler: full booking system for shared lab instruments. Tab layout (Calendar, My Bookings, Admin). Weekly CSS Grid calendar (7am-9pm, 30-min slots, 7 days) and monthly dot-grid view with per-device filtering dropdown. Priority color coding (normal/high/urgent/maintenance) with customizable colors. Booking modal with conflict detection, duration constraints, and advance-day limits. Training/permission system: admin defines certification types, assigns per user, devices require specific certs; co-operator requirement forces lower-category users (undergrads) to select a grad+ co-operator. Admin panels: device CRUD, training checkbox table, settings. Google Calendar push-sync via Google Identity Services OAuth (admin-driven, per-device calendar IDs). Real-time via Firestore `onSnapshot`. Data: `equipment/{equipmentId}` (catalog), `equipmentBookings/{bookingId}` (reservations), `equipmentTraining/{uid}` (certs), `equipmentSettings/config` (singleton)
  - `apps/meetings/` — Lab Meeting: weekly meeting management with fixed-rotation presentation scheduling, collaborative agenda builder (any member adds items), shared notes, action item tracking with cross-meeting carry-over, and post-presentation cross-pollination signals (reaction chips: interesting/questions/collaborate/relevant). Sidebar+main layout with 5 sections: Next Meeting, Schedule, Archive, My Items, Settings. Admin generates semester meetings from config (day/time/skip dates/rotation order). Data: `meetings/{meetingId}` (embedded agendaItems[], actionItems[], feedback[] arrays), `meetingConfig/settings` (rotation, semester config). Real-time via Firestore `onSnapshot`
  - `apps/console/` — Admin Console (admin-only): app management, user permissions, integrations, usage logs
  - `apps/activity-tracker/` — Activity Tracker: daily activity logging with hierarchical categories, ML categorization (Naive Bayes), AI categorization (Anthropic API), milestone tracking, voice input, Chart.js analytics dashboard. Privacy: strictly owner-only Firestore rules. Data: `trackerData/{userId}` (settings, categories, ML model) + `trackerEntries/{userId}/entries/{entryId}` subcollection (task entries with date, categoryPath, duration, milestone, source)
  - `apps/huddle/` — The Huddle: community-driven weekly planning board. Lab members post planned protocols/tasks for the week, others sign up to watch or join. Real-time feed via Firestore `onSnapshot`, week navigation, check-in prompts, protocol linking, status management (completed/cancelled/delayed/skipped). **The Rundown:** non-timeframe task list per week with admin-configurable categories and project associations; join-request workflow where others request to shadow/help, owner accepts and schedules onto the huddle calendar with availability overlap detection. **Lab Schedule:** recurring weekly availability template with per-week overrides; blocks typed as available/unavailable with reasons and rigid/flexible rigidity; Team Availability Gantt view shows all members' schedules per day. Data: `huddlePlans`, `huddleCheckins`, `huddleProtocols`, `huddleRundown` (weekly tasks with joinRequests array), `huddleConfig/settings` (admin-managed categories), `huddleScheduleTemplates/{userId}` (recurring weekly blocks), `huddleScheduleOverrides` (per-week deviations)
  - `apps/scheduler/` — Scheduler: standalone scheduling app moved from dashboard. List view with create/manage/delete; editor view using `McgheeLab.Scheduler` engine with admin/guest/public view switching, guest management, session builder, freeform availability. Self-contained ScheduleDB for Firestore CRUD. Loads `scheduler.js` via script tag. Data: reuses existing `schedules` and `participants` Firestore collections
  - `apps/chat/` — Lab Chat: real-time messaging with channels, DMs, threads, reactions, @mentions, read receipts, and Google Drive file sharing. Desktop: three-panel layout (sidebar + message feed + optional thread panel). Mobile (≤700px): conversation-list-first design with view state machine (`_mobileView`: list/conversation/files); conversation list shows all subscribed channels + DMs with preview/badges; filter dropdown (newest/active/unread/alpha); conversation view replaces sidebar with stats bar (readers/search/files); files view groups channel attachments by type; bottom bar with 5 app quick-nav icons + back arrow FAB; hamburger menu for browse/DM/contacts/search/settings. Subscription-based notifications: all channels visible, users subscribe for alerts. Admin-defined channel categories with channel directory browser. User-organized sidebar with draggable custom groups. Google Drive integration via Google Identity Services OAuth for file uploads to shared lab folder. Browser notifications for @mentions and DMs. Data: `chatConfig/settings` (categories, Drive config), `chatChannels/{channelId}` (metadata + denormalized lastMessage), `chatMessages/{messageId}` (messages with reactions map, readBy array, thread fields), `chatReadState/{uid_channelId}` (per-user read tracking), `chatUserMeta/{uid}` (subscriptions, sidebar layout, prefs)
- **Execution modes:** Embedded (`.app-embedded` class, header hidden, auth via postMessage) vs Standalone (`.app-standalone` class, header visible, auth via Firebase direct)
- **Script load order in standalone:** Firebase SDK (compat) → `../../firebase-config.js` → `../shared/auth-bridge.js` → `../shared/mobile-shell.js` → `../shared/calendar-service.js` → `app.js` (chat app omits mobile-shell.js and calendar-service.js)

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
