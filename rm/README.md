# ResearchManagement Hub

Browser-based dashboard for managing the McGhee Lab — people, funding, papers, courses, service, compliance, and more. Data lives in JSON files; the dashboard reads and writes them through a thin Python server.

## Quickstart

```bash
python3 server.py
```

Open **http://127.0.0.1:8000** in your browser. That's it — no install, no build step.

## How it works

- **`data/`** — JSON files organized by topic (people, funding, projects, service, tasks, calendar, compliance, career, finance). These are the source of truth.
- **`index.html`** — At-a-glance dashboard with summary cards for every category.
- **`pages/`** — Detail pages for each category with full tables and add/edit/delete forms.
- **`server.py`** — Stdlib-only Python server (~100 lines). Serves static files and exposes `GET/PUT /api/data/<path>` to read/write JSON.

## Adding data

Click the **+ Add** button on any detail page. Fill the form, hit Save. The entry is written to the appropriate JSON file on disk.

You can also edit JSON files directly in VS Code — the dashboard picks up changes on page reload.

## Adding a new category

1. Create `data/<topic>/<name>.json` with a top-level key wrapping an array
2. Add a JS file in `js/` that renders the table + forms
3. Add an HTML page in `pages/`
4. Add a summary card in `js/dashboard.js`
5. Add a nav link in `js/nav.js`

## Sibling repos

This hub tracks *pointers* to other lab repos (papers, proposals, courses, tools). It does not embed or duplicate their content. Paths are stored in the relevant JSON files under `data/projects/` and `data/funding/`.
