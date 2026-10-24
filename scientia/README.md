# Scientia In Situ: lab notebook (code export)

*Exported 22 Oct 2026; updated 24 Oct 2026, build `2026-10-24 · PDFs on demand (from the lab repo); pen mode follows the web pen hand`.*

Scientia In Situ is a lab notebook that runs on your own computer. It holds projects, themes, aims, notes, structures (claims, evidence, barriers…), terms, connections, a paper library with a PDF reader, timers, protocols and runs, well plates, image panels, equations, live views, reminders, tasks, recordings, pen ink, and the weekly review. The whole app is one self-contained HTML file. A small Python server saves your data to a folder you choose and syncs phones and tablets.

This ZIP holds **code only**. It contains no notes, images, recordings, backups or device reports. Your data lives in your notebook folder, which this export never touches.

- **New user?** Read [`MANUAL.md`](MANUAL.md) for how to use every feature.
- **Building or changing the app?** Read on.

---

## 1. What's in the ZIP

| Path | What it is |
|---|---|
| `scientia.html` | **The built app.** Fonts, CSS, JS and vendored libraries are all inlined, so it runs fully offline (about 4.2 MB). Rebuilt from `src/` at export time. |
| `src/` | The source, numbered in load order (`01-util.js` … `99-boot.js`), plus `shell.html` and three CSS files. **Edit these, not `scientia.html`.** |
| `build.py` | Joins `src/` + `vendor/` + `fonts.css` into `scientia.html`. |
| `fonts.css` | Archivo, Source Serif 4 (incl. 800 weight) and IBM Plex Mono as base64 `@font-face` (SIL OFL). |
| `vendor/` | Third-party code: MathLive 0.111 (MIT) with KaTeX fonts, PDF.js 3.11.174 (Apache-2.0) and its worker, `qrcode-generator` 1.4.4 (MIT). Licences are included. |
| `icons/` | App icons (180/192/512 px, plus a maskable 512) for installing on a phone or tablet. |
| `launch.bat` | Windows launcher. It frees port 8766 and runs `serve.py`. |
| `serve.py` | Local server: notebook folder, snapshots, Markdown vault, media, sync, pairing, and the routes for handwriting, slides and speech. |
| `sisync.py` | Sync engine (single writer, per-record merge, conflicts, long-poll). |
| `winink.py` | Handwriting → text with Windows' own ink recognizer (WinRT, via a PowerShell helper). |
| `hwread.py` | Older handwriting reader (TrOCR / PyTorch). Kept, but the UI no longer uses it. |
| `sttread.py` | Recording transcription (faster-whisper "small", CPU, offline). |
| `slides.py` | PowerPoint → one PNG per slide, plus slide text and speaker notes (PowerPoint COM). |
| `diagnose-pairing.bat` / `.ps1` | Windows network check for when a phone can't reach the computer. Writes `pairing-report.txt`. |
| `docs/app-readme-original.md` | The app's own running README, as it was in the app folder (a feature-by-feature log in the order things were added). |
| `README.md` | This file. |
| `MANUAL.md` | The user manual. |

**Left out on purpose:** `images/` (your media), `backup/` (a data copy from the 9 Oct wipe), `recordings/`, `pairing-report.txt` (your network details), `__pycache__/`.

---

## 2. Requirements

| Need | For |
|---|---|
| **Windows 10/11** | The full feature set: Windows ink recognizer, PowerPoint slides, `launch.bat`. The core app and server also run on macOS/Linux with `python3 serve.py`. |
| **Python 3.9+** (3.13 tested) | `serve.py` and the helpers. Standard library only for the core. |
| **Chrome or Edge** | File System Access (data folders), keyboard lock (Focus), the CSS Highlight API (multi-select). Safari works on the iPad as a synced device. |
| *Optional:* `faster-whisper`, `av` | Transcribing recordings. Settings → Recordings installs them (about 100 MB, plus the 480 MB model on first use). |
| *Optional:* PowerPoint | Slides. |
| *Optional:* Tailscale | Phones and tablets over a private https address. |
| *Optional:* Node.js | `build.py` syntax-checks the joined JS with `node --check` before writing the file. If Node is missing, the check is skipped. |

---

## 3. Run it

1. Unzip anywhere. A good place is a new `app/` folder; you can replace an older one, because your data is not inside it.
2. Double-click **`launch.bat`**. It opens `http://localhost:8766/scientia.html`.
   - **Keep the port at 8766.** Browser storage belongs to the origin, so another port means another, empty database.
   - Opening the file directly (`file://`) runs, but then storage isn't persistent, DOI lookup fails and the notebook folder is unavailable.
3. First time: **Settings → Notebook folder → Browse… → Connect.** The choice is saved in `%APPDATA%\ScientiaInSitu\config.json`, outside the app. A new copy of the app finds the folder and reloads everything from it.
4. Hover the **SiS** logo to see which build is running.

Environment variables (mostly for tests): `SIS_PORT`, `SIS_NOBROWSER`, `SIS_CONFIG`, `SIS_HW_FAKE`, `SIS_HW_MODEL`, `SIS_SLIDES_FAKE`, `SIS_STT_FAKE`.

---

## 4. Build it

```bash
python build.py        # → wrote scientia.html  4280 KB
```

`build.py`:
1. Reads `src/shell.html` as the page skeleton.
2. Concatenates `src/*.css` and `src/*.js` **in filename order**. The order is load order, so a module that wraps another must sort after it.
3. Inlines vendor CSS, with fonts as data URIs, and vendor JS before the app's JS.
4. Embeds `vendor/workers/*.js` as `<script type="text/js-worker">`, started from a blob URL (PDF.js).
5. Inlines `fonts.css`.
6. Runs `node --check` on the joined JS and **refuses to write** `scientia.html` on a syntax error. This was added after a stray apostrophe in a build string blanked the app on 12 Oct.

After building, reload the page (the server sends no-store headers) or press ⟳ in the header.

---

## 5. Architecture

### 5.1 Layers

```
src/shell.html  ── page skeleton: header, tabs, #view, placeholders for CSS/JS
01–09  core     ── util, schema, IndexedDB store + journal, model (all writes), timers,
                   derived index, library parsers, UI primitives, rich-text editor
10–13  canvas   ── paper (graph-paper canvas), shell/router, note view, wires, note tools
13b–13zz        ── one file per feature, most of them wrapping earlier functions
14–23  pages    ── Today, Portfolio, General, Terms/Lens, Library/Reader, Review,
                   Activity, Settings, Export, Seed, Tasks
99     boot     ── open the DB, load profiles, notebook/sync boot, first render
```

**Design rules followed throughout:**
- **Every authored change goes through `04-model.js` (`M.*`)** so stamps, lineage and the journal stay consistent.
- **The derived index (`06-index.js`, `IX`) is never saved.** It holds term occurrences, chains, backlinks and stats, and is rebuilt in memory after changes.
- **Records are replaced, not mutated.** Write a new object (`d = Object.assign({}, d, {…})`) before `DB.put`. Mutating in place corrupts the journal's "previous value", and undo then breaks; this bug was fixed on 19 Oct.
- **Features are layered by wrapping.** Later files wrap earlier functions (`const _old = X.fn; X.fn = function(){…}`). File order matters.
- **Widgets register themselves.** A widget is a `WIDGETS[kind]` entry (`label`, `w`, `body`, `menu`); an `INSERTS` entry puts it in **+ Insert**.

### 5.2 Data (IndexedDB `DB_VERSION 7`, schema in `02-schema.js`)

| Stores | |
|---|---|
| Structure | `projects`, `themes`, `aims`, `documents` (notes), `blocks` (components), `items` (structures), `terms`, `wires`, `profiles` (note types as data), `templates` |
| Library and data | `library` (CSL-JSON), `datasets` (raw data by reference), `media`, `blobs`, `equations` |
| Planning | `reminders`, `chores`, `views`, `canvases`, `sessions` (time), `flags`, `reviews`, `verdicts` |
| System | `settings`, `journal` (append-only change log with previous values, for undo and time travel) |

- **Structure kinds (12):** claim c, evidence e, barrier b, resolution r, result s, takeaway t, decision d, question q, idea i, deviation v, observation o, reminder m.
- **Relations (9):** follows, leads to, caused, resolves, supports, contradicts, comments on, needs, related. You can also type your own (stored as `c:<words>`).
- **Special component kinds:** `protocol`, `run`, `plate`, `calc`, `eq`, `html`, `figure`, `view`, `timer`, `ink`, `noteref`, `deck`, `pdf`, `rec`, `task`, `matcard`, `ref` (embed).

### 5.3 Where data lives on disk (your notebook folder)

```
.scientia/record.json     the whole record (loaded at launch)
.scientia/ops.jsonl       changes since the last write (nothing lost if the server stops)
.scientia/daily/          one copy per day, last 90 kept
.scientia/kept/           copies taken before anything destructive
.scientia/manifest.json   the Markdown files the app owns (it touches no others)
images/  recordings/      media and audio (+ transcript .json sidecars)
<Project>/<Theme>/<Note>/<NN component>.md   one-way Markdown mirror for Obsidian
Terms/  Library/  Days/  Reminders.md
```

`DATA_EPOCH = 1` (in `13o-vault.js`). Never lower it.

### 5.4 Server API (`serve.py`)

| Area | Routes |
|---|---|
| Notebook | `GET/POST /api/notebook`, `POST /api/notebook/browse`, `GET/POST /api/snapshot`, `GET/POST /api/vault` |
| Media | `GET /api/ping`, `POST /api/media`, `/images/*`, `POST /api/rec`, `GET /api/rec/status`, `POST /api/rec/transcribe`, `/recordings/*` |
| Sync | `/api/sync/hello`, `/push`, `/pull` (long-poll ≤ 25 s), `/state`, `/conflicts`, `/resolve` |
| Pairing and devices | `/api/pair/new`, `/claim`, `/status`, `/pending`, `/decide`; `/api/devices`, `/remove`, `/rename`; `/api/net`, `/api/tailscale/serve` |
| Helpers | `/api/ink/read`, `/api/ink/lang`, `/api/hw/status`, `/api/hw/read`, `/api/hw/install`; `/api/slides`, `/api/slides/status`; `/api/stt/status`, `/api/stt/install` |

- **Local-only routes** need a loopback request with no proxy headers: notebook, browse, vault, pairing approval, devices, net, Tailscale, snapshot replace, and the installers. Tailscale serve relays from 127.0.0.1 with `X-Forwarded-For`, so the proxy-header check is what keeps those requests from counting as local.
- **Paired devices** get an HttpOnly cookie `sis_tok`; tokens are stored as SHA-256 hashes in `devices.json`.
- The server also serves `sw.js` (service worker v2: precaches the shell, images cache-first) and the web manifest.

### 5.5 Sync model

- The computer is the hub and the **single writer**.
- Each device keeps an **outbox** (its own IndexedDB `scientia-sync`), coalesced per record with `prev` and `base`.
- The server does a **three-way merge at field level**. Fields it can't merge become a conflict (⚠ in the header, resolved side by side).
- Devices pull by long-poll. A device that boots while the computer is off runs offline and sends its outbox later.
- Not synced: `journal`, `blobs`, `datasets` (folder permissions are per device).

---

## 6. Module map (`src/`)

| File | Concern |
|---|---|
| `01-util` · `02-schema` · `03-db` · `04-model` | DOM helper `h()`, dates (`fmtStamp`); stores, kinds, relations; IndexedDB mirrored in memory + journal; all mutations |
| `05-timer` · `06-index` · `07-library` · `08-ui` · `09-editor` | Sessions (two concurrent, overlap = multitask); derived index; DOI/BibTeX/RIS/CSL; modals/popovers/pickers; marks-as-ranges editor |
| `10-paper` · `11-shell` · `12-doc` · `12b-wires` · `13-docpanels` | Graph-paper canvas (lens lag, edge fade, pan/zoom); router, header, tabs, keys; note canvas and boxes; colour-coded untangled wires; dock, provenance panel, menus |
| `13b-protocol` · `13c-chain` | Protocols, runs, temporary steps, iterations; experiment stages Planning → Run → Analysis → Reflection |
| `13d-media` · `13e-plate` · `13f-calc` · `13g-embed` · `13h-math` | Media upload; well plates + the `WIDGETS`/`INSERTS` registry; calculator; sandboxed HTML pages; inline/display equations (MathLive) |
| `13i-data` · `13j-materials` · `13r-matsheet` | Datasets by reference, bindings, provenance; materials; material sheets |
| `13k-views` · `13l-day` · `13m-canvas` | Live views + formula language (no eval); day notes, capture, chores, resurfacing, palette; spatial canvas lab (JSON Canvas export) |
| `13n-eq` | LaTeX parser, equation registry, solver (exact isolate, Newton, Levenberg–Marquardt) |
| `13o-vault` · `13p-edit` · `13q-focus` | Notebook folder + Markdown vault; editing/deleting freely, note details, past entries; Focus sessions |
| `13s-remind` · `13t-chaindrop` · `13u-write` · `13v-region` · `13w-termscan` | Reminders; quick chaining; lists, styles, auto-replace; regions; automatic term marking |
| `13x-figure` · `13y-timerui` · `13z-multisel` · `13za-timercmp` · `13zj-headstart` | Image panels; timer button + floating card; several selections at once; timer components (tags, split logging, regions); head start |
| `13zb-move` · `13zi-noteref` · `13zp-links` · `13zr-split` · `13zx-refwidget` | Moving components between notes; note cards; linking by hand (pen dumbbell, cross-pane, per-image ports, embeds); ◫ Split; live embedded widgets |
| `13zc-sync` · `13zd-devices` · `13ze-mobile` · `13zo-install` | Sync client; pairing UI; phone layout; install as an app + full sync |
| `13zf-ink` · `13zg-slim` · `13zh-shapes` · `13zm-pen2` · `13zq-pressure` · `13zu-lasso2` · `13zv-fill` | Pen ink, touch, handwriting; slim widget headers; held-pen shapes; pen hover, finger-tap undo/redo, eraser end; pressure feel; barrel-button lasso, transforms, copy/paste; fill tool and palettes |
| `13zt-table` | Tables from Excel / CSV (sheets copied in, sort, search, edit, paste, formulas) and plots wired to them (scatter, line, bar mean ± SD/SEM, histogram) |
| `13zz2-pen3` · `13zz3-dash` | Pen mode off = pan and move; drag by name or date; pen-button and right-drag loops (region or select); the ink library; dashed and dotted strokes |
| `13zk-docs` · `13zn-rec` | Slides (PowerPoint) and PDF widgets; recordings with transcripts |
| `13zw-quote` · `13zy-reminder` · `13zz-maxhl` | Quotes from embedded PDF/HTML; the Reminder structure (review flag + badges); highlighting maximised PDF/HTML |
| `14-home` · `15-portfolio` · `15b-general` | Today; Portfolio map; notes outside any project |
| `17d-libgroups` | Library themes and groups (store `libsets`; a paper in several groups) |
| `16-lens` · `16b-termforms` | Terms and the term lens; other forms of a term |
| `17-library` · `17b-reader` · `17c-reader2` | Library; PDF reader; pen highlighting and search in papers |
| `21b-canvasexport` · `98-viewer` · `21c-labexport` | A note exported as its live canvas (one read-only HTML file, viewer mode); export for the lab website (desktop) |
| `18-review` · `19-activity` · `20-settings` · `21-export` · `22-seed` · `23-tasks` · `99-boot` | Weekly review; Activity; Settings; JSON + read-only HTML exports; demo seed; Tasks; boot |

---

## 7. Testing

- During development, every feature round was checked with headless Playwright tests (**t0–t66**). Each test ran against a server with an isolated `SIS_CONFIG` and `?seed=demo`.
- Those test scripts lived in Claude's temporary workspace and **are not part of this export**.
- `?seed=demo` loads the demo (Traction Force–ELISA) into an empty browser. The app never seeds on its own.
- Written without a real device to test on, so check these on your machine:
  - Windows ink recognizer (`winink.py`);
  - Whisper on your Windows machine;
  - iPad Safari recording over Tailscale https.

---

## 8. Change history

Compiled from Claude's development log in the project doc **"Scientia In Situ app — Slip Box rebuilt on the journal's paper"** (`claude/app-slipbox-rebuild.md`), the earlier hub and prototype docs, and the app's own README.

**Where Claude kept its log:**
- `claude/app-slipbox-rebuild.md` in the Claude project "Scientia In Situ". This is the main log, written each round, with decisions, internals, bugs and tests.
- `claude/hub-experiment-notebook.md`, `claude/hub-canvas-prototype.md`, `claude/hub-motion-lab.md` and `claude/hub-motion-options.md` cover the prototypes that set the visual direction.
- `claude/pen-responsiveness-research.md` is pen-latency research (Pen Lab prototype). It made no app changes.
- `app/README.md` (the app's user-facing feature log) is copied here as `docs/app-readme-original.md`.

### Before the app (≤ 8 Oct)
- **Spec:** "The Slip Box Rebuilt".
- **First hub** (`hub/`, port 8765): IndexedDB stores, a derived index, schema-driven export, the Traction Force–ELISA demo.
- **Prototypes:**
  - The A/B/C notebook prototypes were rejected ("not my vision").
  - The **experiment journal** (8 Oct) set the direction: minimal chrome, an infinite 14 px graph paper with lens lag and edge fade, everything as a box, right-click as the main menu, mentions and takeaways.

### 8 Oct: the Slip Box rebuilt on the journal's paper (port 8766)
- **Base:** forked the hub's data layer and replaced the UI with the paper. Notes, the term lens and the portfolio map are all canvases.
- **Structures and terms:**
  - Ctrl+Enter opens 12 structure kinds, coloured per kind.
  - Terms render bold and outlined.
  - Ctrl+W marks a term via Focus mode; Alt+W works everywhere.
- **Time and review:** two concurrent timers; the weekly review (Sat→Fri), with the bet and a cycle review.
- **Lineage** keeps old wordings.
- **Protocols:** one block per protocol, drafts with a pulsing light, register, runs, per-step observations, iterations with links, side-by-side view.
- **Experiment stages:** Planning → Run → Analysis → Reflection.
- **Run timer widget.** Observation boxes, pickers with search and sort.
- **Local runs, temporary steps,** and "Update the protocol…".
- **+ Insert registry.** Well plates (colour/image modes, timelapse, carry to Run), media saved via `serve.py`.
- **Calculator, HTML pages, equations** (MathLive).
- **Launcher fixes:** `launch.bat` kills a stale server, no-store caching, the build shown on the logo.

### 9 Oct
- **Term lens:** boxes instead of SVG nodes, co-occurring terms. Live calculator: re-editable lines, `ans` flows through.
- **Data and materials:** data by reference (datasets with fingerprints), provenance chains, materials, PDF reader (PDF.js) with anchored highlights.
- **Views and days:** live views with a formula language, day notes and capture, chores, resurfacing, command palette (Ctrl+P), quick switcher (Ctrl+O), spatial canvas lab.
- **Equations:** boxes with a legend, registry, solver (systems, rearranging), 2×2 split panes, notes on PDF highlights.
- **Notebook folder:** `record.json`, daily and kept copies, the Markdown vault for Obsidian. A one-time legacy wipe, with a backup kept.
- **Editing:** free editing and deletion with cascade and undo, note details, past (backdated) experiments, time entries.
- **Focus sessions.** Material sheets, material cards.

### 12 Oct
- **Bug fixed:** synthesis and other textareas looked unsaved, because `h()` set `value` as an attribute.
- **Reminders** (deadlines, meetings, alerts, repeats).
- **Quick chaining** (drop a wire on empty paper).
- **Writing:** lists, bold/italic/underline, auto-replace. Regions with a hanging list indent. "Needs" relation. Style keys with no selection. Today's timeline shows edits.
- **Incident:** an apostrophe in the BUILD string blanked the app; `build.py` now syntax-checks.
- **Terms find themselves** (automatic marking).
- **Wire label placement fix.**
- **Image panels:** justified rows, crop, letters, captions, labels. A `.mf` CSS clash that stacked every dialog's buttons was fixed.

### 13–14 Oct
- **Timers:** on the canvas, with a floating timer card; timer components (tag by wiring, split logging); timers on regions.
- **Editing:** multi-select (Ctrl-held selections), list levels 1./a./i., true bold weight.
- **Moving and embedding:** moving components between notes; embed ports.

### 15 Oct
- **Sync between devices:** the computer is the hub, Tailscale, pairing with approval, offline outbox, merge and conflicts, phone layout.
- **iPad:** fingers pan and zoom; the pen writes ink components; ink bar; eraser, highlighter, lasso; handwriting → text (TrOCR).

### 16 Oct
- **Connections and widgets:** your own typed connections; full dates on every component; slim widget headers.
- **Pen shapes:** hold the pen still to snap to a shape.
- **Image panels:** navigation and maximise. Note cards (a note inside a note).
- **Fixes:** the handwriting reader repair (TrOCR import error), timer head start.

### 19 Oct
- **Slides** (PowerPoint → pictures + text) and **PDF widgets.**
- **Tasks** (due time = reminder, priority, repeat, subtasks, Done log, Tasks tab).
- **Surface Pro pen:** hover dot, pressure, two/three-finger tap undo/redo, lasso Connect/Merge.
- **Bug fixed:** undo of deletions lost the component's place.
- **Pen:** eraser end (partial erase), no pen context menu. The tap detector was rewritten, and `#touchlog` added.

### 20 Oct
- **Recordings:** microphone, pause, bookmarks, Whisper transcripts with per-line times and playback.
- **Install as an app:** offline devices, service worker v2, full sync.
- **Linking by hand:** pen circle–line–circle, cross-pane connections, per-image ports, embeds by drag; untangled, colour-coded wires lifted over components.
- **Research (no app changes):** pen responsiveness, Pen Lab.

### 21 Oct
- **Fixes:**
  - Transcription failed with newer PyAV (`metadata_errors`); the app now decodes the audio itself.
  - Experiments start with Planning.
- **Pen and handwriting:**
  - Handwriting is read by the **Windows ink recognizer** (replaces TrOCR).
  - Pressure feel settings.
  - ◫ Split button and ⟳ reload.
- **Papers, terms and notes:**
  - Pen highlighting and search in papers.
  - Other forms of a term.
  - General notes (outside projects).
  - Pen swipes no longer navigate the browser in the reader.
- **Pen barrel button:**
  - Lasso, move/scale/rotate/flip, copy and paste.
  - Fill tool, editable palettes; highlighter shapes become areas.

### 22 Oct (this export)
- **Quotes from embedded PDF/HTML:** each quote is a component wired to the file; Connect to…; Ctrl+Enter.
- **Tab** in a component's title moves to its text.
- **Embedded widgets render live** (image panels embedded from another note, with per-image ports).
- **Reminder structure** brought back as an automatic review flag, with badges on connected components.
- **Highlighting a maximised PDF/HTML** with a side panel, like a paper in the Library.
- **Structure colours** for highlights, and a structures-first selection menu.

### 22–24 Oct: after the code export
- **Pen:** two-finger undo removes one stroke at a time (the journal's previous value is the last-written copy, `DB._snap`); eraser size from the pen's curve (Pressure feel → Eraser) and one erase pass per frame; dashed / dotted strokes; pen mode off pans and moves; drag a component by its name or date, double-click to edit; ink frames hidden while writing; the pen button's loop: region (out of pen mode) or select (in it); right-drag asks Region / Select; the ink library (☆). Pen mode is `INK.writing()` = the ink bar out or the web's pen hand.
- **Highlighting:** a pen highlight in a paper, a maximised PDF or an HTML page opens the same popover as a mouse selection.
- **Tables and plots:** Excel / CSV tables with formulas; plots wired to them.
- **Library:** themes and groups of papers.
- **Exports:** a note as its live canvas (one HTML file); export for the lab website.
- **PDF cards on demand** (the lab's V3.894, merged as PR #2 with two fixes) and the V3.900 follow-ups: a failed load is forgotten in `PDFW.load`; a failed card waits for the next redraw.
- Gabe's own Firebase cloud sync stays on his desktop and is not part of the repo: the lab hub is the one cloud.

---

## 9. Known limits

- **Timers:** timers started before 13 Oct, or by protocol runs, have no timer box.
- **Layout:** a component moved onto other boxes overlaps them until you **Tidy layout**. Boxes are pushed down when a box grows but never pulled back up.
- **Sync:**
  - The computer must be running the app for devices to sync, and a device's first open needs it.
  - Undo on a device undoes only that device's changes.
  - Widgets are view-only in the phone layout.
- **Markdown** is one-way (app → files). Edits made in Obsidian are overwritten.
- **Browser limits:**
  - Focus mode can't block OS keys (Alt+Tab, Win).
  - Ctrl+W needs keyboard lock (Chrome/Edge).
- **Equations:** a term that occurs more than once is solved numerically but not shown rearranged.
- **Spatial canvas** is a lab: no minimap.
- **Time travel** is rebuilt from the journal, which records changes made in this app only.
- **Not yet built:** the pen-latency ideas from the Pen Lab research (wet-ink canvas, coalesced events, OS ink trail).

## 10. Licences

- **App code:** © the author.
- **Fonts:** Archivo, Source Serif 4 and IBM Plex Mono (SIL Open Font License).
- **Vendored libraries:** MathLive (MIT), KaTeX fonts (MIT/OFL), PDF.js (Apache-2.0), qrcode-generator (MIT), SheetJS (Apache-2.0). See `vendor/LICENSE*.txt`.
