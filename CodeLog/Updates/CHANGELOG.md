# Changelog

All notable changes to this project will be documented in this file.

Format: [Keep a Changelog](https://keepachangelog.com/)

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
