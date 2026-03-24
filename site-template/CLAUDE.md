# My Website — CLAUDE.md

> Claude Code reads this file automatically and follows its instructions.

## Project Overview

**Project Name:** My Website
**Current version:** V1.0
**Description:** Single Page Application (SPA) built with vanilla HTML, CSS, and JavaScript. Uses hash-based routing and content.json for all site content. No frameworks, no build step — deploys as a static site (GitHub Pages, Netlify, etc.).

## Repository Layout

```
my-website/
├── CLAUDE.md                 # THIS FILE
├── index.html                # HTML shell with persistent header/footer
├── app.js                    # Main SPA router & page logic
├── content.json              # All site content (edit content here, not in JS)
├── styles.css                # CSS styling
├── Images/                   # Site images
│   ├── hero/                 # Hero section images/videos
│   └── general/              # General site images
├── Videos/                   # Video files
├── CodeLog/
│   ├── Updates/CHANGELOG.md  # Version history
│   ├── Architecture/ARCHITECTURE.md
│   ├── ClaudesPlan/          # Implementation plans (one per version/feature)
│   └── References/           # Reference materials
└── scripts/
    └── version_push.py       # Automated version push tool
```

## Conventions

- **Architecture:** Vanilla HTML/CSS/JS — no frameworks, no build step
- **Routing:** Hash-based SPA routing (#/home, #/about, #/projects, #/team, #/contact)
- **Content:** All text content lives in `content.json` — edit content there, not in JS
- **Images:** Place in appropriate `Images/` subdirectory; reference from `content.json`
- **Naming:** camelCase for JS functions and variables
- **Mobile:** All layouts must be responsive; touch interactions supported

## Key Technical Decisions

- **Vanilla JS SPA** — No framework dependencies; deployed as a static site
- **Hash routing** — Works with GitHub Pages without server-side config
- **content.json** — Separates content from presentation logic for easy updates
- **Persistent header/footer** — Only page content swaps on navigation

## Documentation Requirements

These are **mandatory** for every code change:

### 1. Plan First (CodeLog/ClaudesPlan/)
Before implementing any significant feature or change:
- Create `CodeLog/ClaudesPlan/V{version}_{feature_name}.md`
- Include: goal, approach, files to modify, key decisions
- This becomes the permanent record of *why* and *how*

### 2. Changelog (CodeLog/Updates/CHANGELOG.md)
Every code change must be recorded:
- New features go under `Added`
- Modifications go under `Changed`
- Bug fixes go under `Bug Fixes`
- Include parameter names, function signatures, and brief technical detail

### 3. Architecture (CodeLog/Architecture/ARCHITECTURE.md)
Update when:
- New modules or files are added
- Module responsibilities change
- Data flow between components changes
- New external dependencies are introduced

## Version Control Workflow

1. Work on `Version-X.Y` branch
2. Every plan document = potential new version
3. When ready to release:
   - Stage and commit all changes
   - Push current branch (this IS the release)
   - Create next branch `Version-X.(Y+1)`
   - Push new branch — it becomes the working branch
4. Use `python3 scripts/version_push.py` to automate steps 3-4

Branch naming: `Version-X.Y` (e.g., `Version-1.0`, `Version-2.3`)
Version after X.9 is X.10 (or (X+1).0 for major bumps).

## Running the Code

This is a static site. To run locally:

```bash
# Simple local server
python3 -m http.server 8000
# Then open http://localhost:8000
```

Or use the VSCode Live Server extension.

## Dependencies

- No build tools or package managers required
- Pure HTML, CSS, and JavaScript
- Hosted as a static site (GitHub Pages, Netlify, etc.)
