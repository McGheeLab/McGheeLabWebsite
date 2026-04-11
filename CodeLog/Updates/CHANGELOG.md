# Changelog

All notable changes to this project will be documented in this file.

Format: [Keep a Changelog](https://keepachangelog.com/)

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
