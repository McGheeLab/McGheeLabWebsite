# ResearchManagement Hub

Browser-based dashboard for managing the McGhee Lab — people, funding,
papers, courses, service, compliance, and more. Production data lives in
Firestore; legacy seed JSON is kept in the sibling
`ResearchManagement/data/` directory for local dev only.

This `/rm/` tree is the **working source of truth**. Edit files here in
place. Production deploy is Cyberduck FTP of the whole McGheeLabWebsite
repo to godaddy (RM ends up at `mcgheelab.com/rm/`).

## Quickstart

```bash
cd /Users/alexmcghee/Documents/GitHub/McGheeLabWebsite
RM_WRITE_ALLOWLIST=mcgheealex@gmail.com python3 rm/server.py
```

Open **http://localhost:8000/rm/** in your browser. No install, no build
step.

[`rm/server.py`](server.py) is a thin launcher that hands off to the real
RM dev server in `../../ResearchManagement/server.py`. The sibling server
mounts `/rm/*` back at this `rm/` tree, so edits here are picked up live.
JSON read/write goes to `../../ResearchManagement/data/*.json` for the
legacy seed paths.

## How it works

- [`index.html`](index.html) — at-a-glance dashboard with summary cards.
- [`pages/`](pages/) — detail pages per category (people, funding, tasks,
  papers, calendar, compliance, etc.).
- [`js/`](js/) — vanilla-JS renderers + Firestore adapter. Critical hubs:
  [`api-routes.js`](js/api-routes.js), [`api-firestore-adapter.js`](js/api-firestore-adapter.js),
  [`util.js`](js/util.js), [`firebase-bridge.js`](js/firebase-bridge.js).
- [`css/`](css/) — global styles + paper-editor styles.
- [`vendor/pdfjs/`](vendor/pdfjs/) — pdf.js for the paper viewer.

All internal links use `/rm/...` absolute paths. Don't introduce bare
`/css/...` or `/js/...`.

## Adding data

Click the **+ Add** button on any detail page. Saves go through the
Firestore adapter (per-user or admin-write shared, depending on the
route's `scope`). The on-disk JSON in `../../ResearchManagement/data/` is
a local-dev mirror only — production reads/writes Firestore.

## Adding a new category

See [CLAUDE.md](CLAUDE.md) for the full step-by-step. Briefly:

1. Add a route to [`js/api-routes.js`](js/api-routes.js) (`scope: 'user'`
   or `scope: 'lab'`).
2. Add a JS renderer in `js/<topic>.js` using `api.load()` / `api.save()`.
3. Add an HTML page in `pages/<topic>.html` with `/rm/...` paths.
4. Add a summary card in [`js/dashboard.js`](js/dashboard.js).
5. Add a nav link in [`js/nav.js`](js/nav.js).
6. If new Firestore paths are needed, edit
   [`../firestore.rules`](../firestore.rules) and
   `firebase deploy --only firestore:rules` from the parent repo.

## Sibling repos

RM tracks *pointers* to other lab repos (papers, proposals, courses,
tools). It does not embed or duplicate their content. Paths are stored in
the relevant Firestore collections.
