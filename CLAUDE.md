# McGheeLab Website — CLAUDE.md

> Claude Code reads this file automatically and follows its instructions.

## Project Overview

**Project Name:** McGheeLab Website
**Current version:** V1.0
**Description:** Single Page Application (SPA) for the McGhee Lab at the University of Arizona. Showcases research in microfluidics, 3D bioprinting, and traction force microscopy. The site covers mission, research areas, projects, team, classes, and contact information.

## Repository Layout

```
mcgheelab.github.io/
├── CLAUDE.md                 # THIS FILE
├── index.html                # HTML shell with persistent header/footer
├── app.js                    # Main SPA router & page logic
├── content.json              # Static seed content (mission text, contact) — dynamic content is Firestore
├── styles.css                # CSS styling
├── Images/                   # Research photos, diagrams, team photos
│   ├── research/             # TFM, ME3B, microfluidics, CELLS, ELISA
│   ├── mission/              # Mission statement graphics
│   └── team/                 # Team member photos
├── Videos/                   # Hero video (webm)
├── poster/                   # Academic poster subsite
├── CodeLog/
│   ├── Updates/CHANGELOG.md  # Version history
│   ├── Architecture/ARCHITECTURE.md
│   ├── ClaudesPlan/          # Implementation plans (one per version/feature)
│   └── References/           # Literature citations
├── Research/                 # Literature reviews
├── scripts/                  # Utility scripts (version_push.py)
└── requirements.txt          # Python dependencies (auto-generated)
```

## Conventions

- **Architecture:** Vanilla HTML/CSS/JS — no frameworks, no build step
- **Routing:** Hash-based SPA routing (#/mission, #/research, #/projects, #/team, #/classes, #/contact)
- **Content (V3.302 correction):** `content.json` holds only static seed
  content (mission sections, contact info, classes intro). Research
  stories, news posts, project packages, and team members live in
  **Firestore** (`stories`, `newsPosts`, `projectPackages`, `users` /
  `teamProfiles`) and are authored through the in-site dashboard editors
  in `user-system.js` (login → `#/dashboard`), with contributor
  submissions reviewed by admins. Editing content.json still requires an
  FTP redeploy; Firestore content does not.
- **Images:** Static site images go in `Images/`; story/news media is
  uploaded through the editors to Firebase Storage as webp thumb/medium/full sets
- **Naming:** camelCase for JS functions and variables
- **Mobile:** All layouts must be responsive; touch interactions supported

## Key Technical Decisions

- **Vanilla JS SPA** — No framework dependencies; deployed as GitHub Pages static site
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
- Hosted on GitHub Pages

## RM (ResearchManagement Hub)

The McGhee Lab's lab-management dashboard ships under `mcgheelab.com/rm/`
and lives in this repo's [`rm/`](rm/) subdirectory. As of 2026-05-04 this
is the **working source of truth** for RM — edit here directly. The old
path-rewriting deploy from the sibling `ResearchManagement/` repo is
retired (see that repo's `scripts/deploy_to_rm_subdir.py` deprecation
note).

When working on RM, read [rm/CLAUDE.md](rm/CLAUDE.md) for full guidance.
Quick references:

| Concern | Path |
|---|---|
| RM source code | [rm/](rm/) (index.html, css/, js/, pages/, vendor/) |
| RM dev server (launcher) | [rm/server.py](rm/server.py) → execs `../../ResearchManagement/server.py` |
| Local seed JSON (dev only) | `../ResearchManagement/data/` (sibling repo, not in this repo) |
| Firestore security rules | [firestore.rules](firestore.rules) — deploy with `firebase deploy --only firestore:rules` |
| Firestore composite indexes | [firestore.indexes.json](firestore.indexes.json) — deploy with `firebase deploy --only firestore:indexes` |
| Storage rules | [storage.rules](storage.rules) — deploy with `firebase deploy --only storage:rules` |
| Cloud Functions used by RM | [functions/](functions/) — `gmail-scraper.js`, `calendar-proxy.js`, `ics-scraper.js`, `stats-updater.js`, `oauth.js`, `chat.js`, `tasks.js`. Deploy with `firebase deploy --only functions`. |
| Shared with parent SPA | [user-system.js](user-system.js) (bootstraps `users/{uid}` for RM's `isLabMember()` gate); [cv-builder.js](cv-builder.js) (shares `cvData/{uid}` with `rm/js/cv-schemas.js`) |

Local dev:

```bash
RM_WRITE_ALLOWLIST=mcgheealex@gmail.com python3 rm/server.py
# open http://localhost:8000/rm/
```

Production deploy:

- **RM static tree:** Cyberduck FTP this repo to godaddy. The `rm/`
  subdir lands at `mcgheelab.com/rm/`. No build step.
- **Firebase rules / indexes / functions:** `firebase deploy --only ...`
  from this repo root. Never paste rules into the Firebase console.
