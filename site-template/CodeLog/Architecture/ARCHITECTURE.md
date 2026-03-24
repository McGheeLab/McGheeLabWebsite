# Architecture

**Version:** V1.0

## System Overview

This website is a single-page application (SPA) using vanilla HTML, CSS, and JavaScript. It uses hash-based routing to navigate between sections without page reloads. All site content is stored in content.json and injected dynamically by app.js.

## Module Breakdown

### index.html
- **Purpose:** HTML shell with persistent header, navigation, hero, and footer
- **Key elements:** `#app` container swapped by router, hamburger nav menu, bottom tab bar
- **SEO:** Meta description, keywords, OpenGraph, and Twitter Card tags
- **Script loading:** `app.js` (deferred)

### app.js
- **Purpose:** SPA router, page rendering, and UI interactions
- **Key functions:**
  - `safeFetchJSON()` — loads content.json with fallback
  - `normalizeData()` — normalizes raw JSON into consistent shape
  - `onRouteChange()` — hash-based route matching
  - `render()` — page dispatch, cleanup, scroll, reveal
  - `renderSections()` — generic content block renderer (home, about)
  - `renderProjects()` — card grid for projects
  - `renderTeam()` — card grid for team members
  - `renderContact()` — contact page with address
  - `setupMenu()` — hamburger drawer toggle
  - `enableLazyImages()` — IntersectionObserver lazy loading
  - `enableReveal()` — scroll-triggered animations
- **Pattern:** IIFE wraps all code; state object tracks observers and cleanup functions
- **Error handling:** Render functions wrapped in try/catch with user-facing fallback

### content.json
- **Purpose:** All site text content, separated from presentation
- **Schema:**
  - `site` — name, tagline, contact info
  - `home` — array of section objects (title, body, points, image)
  - `about` — array of section objects
  - `projects` — array of project objects (title, body, image)
  - `team` — array of person objects (name, role, photo, bio)
  - `contact` — heading and body text

### styles.css
- **Purpose:** All visual styling
- **Organization:** 11 numbered sections from design tokens to responsive breakpoints
- **Design tokens:** CSS custom properties in `:root` for colors, radii, shadows, layout constants
- **Responsive:** Desktop (>=768px) shows inline nav; Mobile (<768px) shows hamburger + bottom tabs
- **Accessibility:** Reduced-motion media query, skip-link, focus styles

## Data Flow

```
content.json → fetch → normalizeData() → state.data
                                            ↓
                        onRouteChange() → render(page) → DOM update
                                            ↓
                        enableLazyImages() + enableReveal()
```

## Adding a New Page

1. Add a route case in the `render()` switch in app.js
2. Create a `renderYourPage()` function
3. Add content to content.json
4. Add nav links in index.html (desktop-nav, site-nav, bottom-tabs, footer-links)
5. Update this architecture doc
