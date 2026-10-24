# Scientia In Situ — the lab's notebook app, one source for desktop and web

> Gabe's app (see [README.md](README.md) for his tour of the files and [MANUAL.md](MANUAL.md) for how it is
> used). Since V3.866 (2026-10-23) this folder is the **single source of truth** for Scientia, shared by Gabe
> and the lab in this repo. Program plan: [CodeLog/ClaudesPlan/V3.866_scientia_rm_unification.md](../CodeLog/ClaudesPlan/V3.866_scientia_rm_unification.md).

## Two targets, one source

| Target | Built file | Served by | Data |
|---|---|---|---|
| **Desktop** (Gabe's computer, Windows/Mac) | `scientia/scientia.html` | `serve.py` / `launch.bat` from this folder | the notebook folder on disk (`.scientia/record.json`, `images/`, `recordings/`) |
| **Web** (mcgheelab.com/rm/scientia/, inside the Lab Notebook) | `rm/scientia/scientia.html` | the lab site (FTP, end-of-turn auto-deploy) | the person's cloud hub (`userData/{uid}/scientia/hub`, the `scientiaHub` Cloud Function) |

Both built files come from `src/` and are **git-ignored build outputs**:

```bash
python3 scripts/scientia_build.py          # after git pull, and after any change under scientia/
python3 scripts/scientia_build.py --check  # are the files on disk current? (a release gate)
```

The web file is the desktop file plus one line — `<script src="cloud-sync.js?v=<hash>">` before `01-util.js` — which
makes the untouched app a *device* of the cloud hub and lets the Lab Notebook drive it (`rm/scientia/cloud-sync.js`).
`rm/scientia/icons/` and `MANUAL.md` are copies the build script refreshes. **Edit `src/`, never a built file.**

## What lives where

| Path | Owner | Notes |
|---|---|---|
| `scientia/src/*.js`, `*.css`, `shell.html` | Gabe (the app) | numbered load order; `build.py` joins them; `node --check` gates the build |
| `scientia/serve.py`, `sisync.py`, `winink.py`, `sttread.py`, `slides.py`, `hwread.py`, `launch.bat`, `diagnose-pairing.*` | Gabe (the desktop server) | desktop only; never deployed |
| `scientia/vendor/`, `fonts.css`, `icons/` | Gabe | third-party, licences included |
| `rm/scientia/cloud-sync.js` | the lab | the web layer: hub protocol over `fetch`, notebook bridge (postMessage), media map |
| `rm/scientia/lab-mode.js` | the lab | **A note's details in its first block (V3.885)**: your head box gains Title · Type · Template · Project · Theme (always editable); `App.newDoc` / `CHAIN.start` make the note at once (no dialog — except a protocol run's); template items carry `tpl { id, label0, text0 }` and swap in place until one is edited, then the person chooses keep-edited or replace-everything. **Wheels (V3.896)**: the pills take places — ＋ *Quick cast* above your bottom bar (its items chosen with a bolt toggle added to each row of your + Insert list), ⊕ top left (your ink bar shifts right of it), ✦ top right under your tool buttons, ✎ bottom right; a Quick cast / tools / zoom fan left open 10 s docks as a row or column; pen settings are a cog in ✎'s fan that shows / hides your ink bar (your palettes, widths, fill, pressure). **Lit reviews (V3.889)**: a tab after Portfolio for literature reviews — each is one of your `literature` notes outside any project carrying `review { topic, projectIds }` (your desktop sees an ordinary literature note); its first block holds title, topic and the projects it serves (any number); it shows in each linked project's region and page and never among your General notes (`GENERAL.docs` wrapped). **Transcribe (V3.887)**: on the web a saved recording shows *Transcribe* with its likely cost, run the person's own way (chosen in RM Settings → Speech to text: free Whisper in the browser, or their own OpenAI / Google key — `rm/js/speech-to-text.js`); the lines go through your `REC.apply`, exactly as your desktop Whisper writes them, plus `rec.stt = { provider, model, at }`. **One Mark (V3.886)**: your ◆ (Alt+M) is the only mark button; each bookmark's glyph in your list opens your `ctxMenu` to say what it is (important · question · decision · to do) or that it lasts until now (`end`). **The one recorder (V3.884)**: on the web your Recording component saves its audio to the lab's cloud a part a minute (`api/rec/part` → `api/rec/compose`; an interrupted one is recovered), its marks gain kinds (your ◆ is *important*) and spans in your own `marks` list, and ink drawn in the note while it records carries `stroke.rt = [recId, t0, t1]`; the shared rules are `rm/js/recorder-core.js`. Your desktop recorder and Whisper are untouched. **Pills + saving quick notes (V3.882)**: every note has the Lab Notebook's movable pills (✎ zoom · move · pen · highlighter · lasso, ＋ insert, ✦ tools, ⊕ view), driving your `INK`, `INSERTS`, `TIMER`, `CALC`, `EQ` and `Paper` (the hand is read back from `INK`, so your ink bar and the pill agree); *Save to a project…* asks a quick note's title, type, project and theme. **Portfolio (V3.880)**: what the PI assigned in RM (research cards, projects — mirrored by the hub as `projects` rows `rm-f-` / `rm-p-` with `rm: true`, aims under an assigned grant as themes `rm-a-`) comes first, as region cards you drag by the header and fold; then Quick notes (your General notes, 15b — *+ Quick note* opens a blank page with a template bar; *Add to project…* is your `GENERAL.move`); then your own projects. A note in an RM project has *Seen by: Only me / Lab members* (`doc.share`), and the hub lists it on that card / project in RM (`scientiaNotes`). **Phase 2 (V3.876–V3.878, complete)**: RM cards inside notes — the `rmpaper` card (RM highlights), a ✓ on every component that reports it to a My Week step, the inventory-backed material card, *Run a lab protocol from RM* (becomes your own protocol block with `rm {…}` — runs are yours), `rmaction` (*Something I did*), `rmcollection`; for RM's heavy UI (the paper reader, the report picker) the app asks the Lab Notebook that hosts it over postMessage (`rm-read`, `rm-report` → `rm-ack`), so nothing is copied. A new block kind (`rmpaper`) carries readable text so the desktop shows it. **Phase 1 (V3.869–V3.874, complete)**: reminders and chores become dated items in My Week and timer sessions + edits become RM activity events — both done by the hub on every pull, so they apply to the desktop's data too (V3.874). The web build only (`window.SIS_TARGET === 'web'`, loaded after the app). Reshapes the running app from outside — the Library tab is the lab's library mirrored from RM by the hub (`library` rows with `rm: true`, id = the RM item id, so cites keep working); Activity and Data tabs are gone; the "+ material" picker and the Materials page search RM's inventory (`api/rm/inventory`) and a picked item becomes a resource note with `inventoryId` (usage is logged in RM); a task component becomes an RM task (`api/rm/tasks`, `block.rmTaskId`; the hub reconciles done both ways on every hello, pushing block ops as device "RM tasks"). Nothing in `src/` branches on the target. Harness: `scripts/tests/v3869-scientia-lab-mode-harness.html` |
| `rm/scientia/scientia-cloud.py` | the lab | the desktop bridge: a device of both hubs (Gabe downloads it from the notebook's sync panel) |
| `functions/scientia-hub.js`, `scientia-hub-core.js` | the lab | the cloud hub (Gabe's protocol on Firestore) |
| `rm/js/notebook-scientia.js`, `rm/css/notebook-scientia.css` | the lab | Scientia as a notebook of the Lab Notebook |
| `rm/js/scientia-notes.js` | the lab | the notes filed under a research card / project, listed in RM (V3.880) |

Changes to the app (`src/`) are Gabe's domain; changes to the lab layer are ours. A change that needs both
(a new RM-backed tab, a ported notebook feature) is one branch and one PR that touches both, reviewed by both.

## Git workflow (Gabe + the lab in one repo) — V3.868

Once per clone:

```bash
python3 scripts/merge_check.py install     # the push gate (.githooks/pre-push) + the manifest merge driver
python3 scripts/scientia_build.py          # the two built files (git-ignored)
```

1. **Branch per change**: `scientia/<topic>` for app work, `rm/<topic>` for lab work, from `main`. Gabe's work reaches
   `main` by pull request; the lab's own turns land on `main` through the end-of-turn auto-push
   (`scripts/git_autopush.py`, which runs the same gate).
2. **Every `git push` runs the gate** — `scripts/merge_check.py` (plan
   [V3.868](../CodeLog/ClaudesPlan/V3.868_git_push_hook_merge_checker.md)). It refuses the push when:
   - a **new module** (`scientia/src/*.js`, `rm/js/*.js`, `rm/pages/*.html`, `functions/*.js`) is not in
     [`CodeLog/features.json`](../CodeLog/features.json) — add the file to the feature it belongs to, or add an entry;
   - a change **looks like a feature we already have** (a new tab, store, page, export, route, or a new file whose
     identity matches another feature's name or keywords) and the registry does not say how they relate. The report
     names the pair and the fix: `"extends": "<id>"` (build on it), `"merges_into": "<id>"` (fold into it; `status:
     retiring`), `"related": ["<id>"]` (uses it), or `"distinct_from": {"<id>": "why"}` (reviewed, kept apart). **This
     is deliberate: the lab does not want two of anything. If your feature is close to an RM feature, the answer is
     usually to build it on RM's and have the desktop pull from it.** `python3 scripts/merge_check.py queue` lists what
     is already folding into what;
   - the branch **would not merge** with `origin/main` (`git fetch origin && git rebase origin/main`);
   - a **gate fails**: `node --check`, the Scientia build, `node functions/test/scientia-hub.test.js`, the icon/emoji
     gate. Preview before committing: `python3 scripts/merge_check.py worktree`. The same check runs on GitHub for
     every pull request (`.github/workflows/merge-check.yml`), so `--no-verify` does not skip it.
3. **Pull request to `main`**, one reviewer from the other side. Small PRs; one topic each. The registry diff is part
   of the review: a `distinct_from` reason is a claim the reviewer can disagree with.
4. **Versions**: the app keeps Gabe's `BUILD` string in `src/01-util.js` (bump it when the app changes); the site keeps
   its `V3.x` line in `CodeLog/Updates/CHANGELOG.md` (every PR that touches the lab layer adds an entry).
5. **Never in git**: built files, a notebook folder, `images/`, `recordings/`, `backup/`, `pairing-report.txt`,
   `__pycache__/`, and anything confidential — keys, `.env`, payroll, grant documents (all in `.gitignore`; the lab's
   auto-push holds them out even when the list misses one). **The repo is public.**
6. **Deploy**: only `rm/**` reaches mcgheelab.com (`deploy/site.json`). This folder never does. `python3
   scripts/deploy.py ftp` ships only what changed, and only from an up-to-date `main` (it refuses a side branch or a
   tree behind `origin/main`); it rebuilds the web Scientia first when `src/` is newer. The lab's end-of-turn
   auto-deploy does the same from Alex's computer, after pulling your merged work.

## Access (what Gabe needs, and where it is set up)

| Needs | Where it comes from | On Gabe's side |
|---|---|---|
| **GitHub** write on `McGheeLab/McGheeLabWebsite` | Alex invited `RTgabrieldeclercq` (2026-10-23) | accept the invitation, clone, run the two once-per-clone commands above |
| **Firebase** (deploy `functions/scientia-hub*.js`, rules; read the console) | Alex made `gabrieldeclercq0@gmail.com` an Editor on `mcgheelab-f56cc` (2026-10-23) | `npm i -g firebase-tools`, `firebase login`, `firebase use mcgheelab-f56cc`; `cd functions && npm i`; `firebase deploy --only functions:scientiaHub` |
| **FTP** (ship the web build and lab-layer files yourself) | Alex creates a second FTP account in the host's cPanel (FTP Accounts → add user, directory = the same web root the lab account uses, strong password) — never the lab's own login | create `scripts/.env` (git-ignored) with `MCGHEELAB_FTP_USER=<user>@mcgheelab.com` and `MCGHEELAB_FTP_PASSWORD=…`; then `python3 scripts/deploy.py status` / `ftp` |

The Firebase client side needs nothing: the web app signs in with the lab account like every RM page, and the hub
function checks the lab-member role.

## Local dev

```bash
# the desktop app, as Gabe runs it (port 8766; set a notebook folder in Settings)
python3 scientia/serve.py
# the web app inside the Lab Notebook (the repo served statically; sign in on the lab site)
python3 -m http.server 8000 && open http://localhost:8000/rm/pages/notebook.html?notebook=scientia
```

The web app's `api/…` calls go to the live `scientiaHub` function (see `rm/scientia/cloud-sync.js`); a local
stand-in for the bridge is `node scripts/scientia_hub_dev.js`.

## Rules that are easy to break

- The app's globals (`S`, `$`, `DB`, `M`, `App`, `IX`, `SYNC`, `MEDIA`…) are top-level `const`s in one classic
  script. The web app therefore runs in its own document (an iframe inside the Lab Notebook); never load it into an
  RM page's document.
- `SYNC`, `DISK`, `VAULT`, `MEDIA` assume "the computer that holds the record" answers `api/sync/hello`. On the web
  that computer is the cloud hub and `local` is always `false`; keep new desktop-only routes behind
  `is_local()` in `serve.py` and give them a stub in `functions/scientia-hub-core.js` `route()` so the web build
  never sees a 404 where it expects JSON.
- No colour emoji in UI the lab ships (the emoji gate skips `rm/scientia/` for Gabe's own chrome, but anything the
  lab adds uses `ICON.svg` / words).
- No browser `prompt` / `alert` / `confirm` in the lab layer (inline forms, two-tap deletes, toasts).
