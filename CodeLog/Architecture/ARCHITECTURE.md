# Architecture

**Version:** V1.1

## System Overview

McGheeLab website is a single-page application (SPA) using vanilla HTML, CSS, and JavaScript. It uses hash-based routing to navigate between sections without page reloads. All site content is stored in a JSON file, separating data from presentation.

## Module Breakdown

### index.html
- **Purpose:** HTML shell with persistent header, navigation drawer, hero, and footer
- **Key elements:** `#page-content` container swapped by router, hamburger nav menu
- **SEO:** Meta description, keywords, OpenGraph, and Twitter Card tags for search and social sharing

### app.js
- **Purpose:** SPA router, page rendering, and UI interactions
- **Key functions:** Hash-based route matching, dynamic content injection from JSON, image gallery/carousel logic, mobile touch support
- **Error handling:** Render functions wrapped in try/catch with user-facing fallback messages
- **Size:** ~32 KB — primary application logic

### content.json
- **Purpose:** All site content — mission text, research descriptions, project details, team members, course info
- **Key sections:** mission, research, projects, team, classes, contact
- **Image paths:** All use `Images/` prefix (capital I) to match folder on case-sensitive servers

### styles.css
- **Purpose:** All visual styling, responsive layout, animations
- **Responsive strategy:** Fluid typography via `clamp()`, auto-fit grids, breakpoints at 768px (tablet) and 600px (phone)
- **Size:** ~20 KB

### robots.txt
- **Purpose:** Instructs search engine crawlers; allows all indexing
- **Points to:** sitemap.xml

### sitemap.xml
- **Purpose:** Lists all hash routes with priority weights for search engine discovery

### poster/
- **Purpose:** Standalone academic poster sub-site with its own app.js, styles.css, and Firebase integration

## Data Flow

```
URL hash change → app.js router → fetch content.json → render page section → inject into #page-content
```

If rendering fails, error boundary catches the exception and shows a fallback message.

## Design Decisions

- **No frameworks:** Keeps deployment simple (GitHub Pages), no build step needed
- **Hash routing:** Required for GitHub Pages (no server-side routing)
- **JSON content store:** Enables non-developers to update text/team info without touching JS
- **Single CSS file:** Site is small enough that splitting adds unnecessary complexity
- **Fluid typography:** Body text scales between 15px–17px via `clamp()` for readability across devices
- **Mobile video skip:** Hero video hidden below 768px to save bandwidth (barely visible at 20% opacity anyway)
- **44px touch targets:** Subnav chips and interactive elements meet WCAG minimum for touch devices
