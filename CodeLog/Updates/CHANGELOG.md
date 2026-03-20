# Changelog

All notable changes to this project will be documented in this file.

Format: [Keep a Changelog](https://keepachangelog.com/)

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
