# Architecture

**Version:** V2.0

## System Overview

McGheeLab website is a single-page application (SPA) using vanilla HTML, CSS, and JavaScript. It uses hash-based routing to navigate between sections without page reloads. Public site content is stored in content.json, while user-generated content (stories, profiles) lives in Firebase Firestore. Authentication is handled by Firebase Auth with invitation-based registration.

## Module Breakdown

### index.html
- **Purpose:** HTML shell with persistent header, navigation drawer, hero, and footer
- **Key elements:** `#app` container swapped by router, hamburger nav menu
- **SEO:** Meta description, keywords, OpenGraph, and Twitter Card tags
- **User system nav:** Dashboard, Admin, Login/Logout links (conditionally visible based on auth state)
- **Script loading:** Firebase SDK (compat) → firebase-config.js → user-system.js → migrate-content.js → app.js (all deferred, in order)

### app.js
- **Purpose:** SPA router, page rendering, and UI interactions
- **Key functions:** Hash-based route matching with multi-segment support (`#/dashboard/story/:id`), dynamic content injection, expandable stories, mobile touch support
- **User system integration:** Routes for login, dashboard, admin, logout; wires user-system page interactivity; appends Firestore stories to projects page
- **Error handling:** Render functions wrapped in try/catch with user-facing fallback messages

### firebase-config.js
- **Purpose:** Firebase initialization with project credentials
- **Graceful degradation:** If credentials are placeholder values, logs a warning and skips init — site works without Firebase

### user-system.js
- **Purpose:** All user system logic — authentication, Firestore CRUD, image processing, dashboard, story editor, admin panel
- **Key sections:**
  - **Media utilities:** Client-side image resize via Canvas API → three webp resolutions (thumb 300px, medium 800px, full 1600px); video upload (mp4/webm, up to 50 MB) direct to Firebase Storage
  - **DB operations:** CRUD for users, stories, invitations collections
  - **Auth:** Login, invitation-gated registration, logout, auth state management, navigation updates
  - **Dashboard:** Profile editing (name, bio, photo, category), story list with create/edit/delete
  - **Story editor:** Multi-section editor with text areas, drag-and-drop image/video upload, reorder/remove sections, live preview modal, save draft / publish / submit for review
  - **Admin panel:** Tabbed interface — user management (role changes), invitation generator (with copy link), pending story review (approve/reject)
- **Exports:** All render/wire functions and Auth/DB objects on `window.McgheeLab` namespace

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
- **Access model:** Role-based (admin/editor/contributor); published stories readable by all; users write own profile; 10 MB image / 50 MB video upload limit for stories

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
