# Deploying mcgheelab.com — upload only what changed

The site is plain files on GoDaddy, updated over FTP. Until V3.817 the routine
was "drag the repo (or all of `rm/`) into Cyberduck", which re-sent 1,000+
files for a five-file change **and** sent things that are not the site at all
(CodeLog, functions, scripts, Data, keys).

`scripts/deploy.py` fixes both. It knows what the site is (`site.json`) and
what is already live (`manifest.json`, a content hash per file), and moves
only the difference.

## It is automatic (V3.818)

When Claude finishes a turn in which site files changed, a hook runs
`python3 scripts/deploy.py autodeploy`: every changed `.js`/`.json` is
syntax-checked (one broken file holds the whole upload and tells you which),
the files are uploaded, verified over HTTPS, and you see "Deployed N file(s)
to mcgheelab.com…" in the Claude window.

- **Pause it** (e.g. during a live lecture): set `"autoDeploy": false` in
  `site.json`, or `export MCGHEELAB_AUTODEPLOY=0` before launching Claude.
- **Your own VS Code edits** have no Claude turn, so press ⇧⌘B for those.

## The manual routine (VS Code: Terminal → Run Task…, or ⇧⌘B for the first one)

| Want to… | Run |
|---|---|
| Upload what changed, no Cyberduck | `python3 scripts/deploy.py ftp` |
| See what would be uploaded | `python3 scripts/deploy.py status` |
| Use Cyberduck anyway | `python3 scripts/deploy.py stage` → drag the contents of `deploy/upload/` onto `/` → `python3 scripts/deploy.py verify` |
| Check the server for files that should not be public | `python3 scripts/deploy.py audit` |
| Make Finder show folders as recently modified | `python3 scripts/touch_folders.py` (runs automatically after every Claude edit) |

`ftp` shows the list, asks "Proceed?", uploads, then checks every file over
HTTPS and records it in `manifest.json`. The password comes from the macOS
Keychain entry Cyberduck already saved (macOS asks you to allow it the first
time), or from `MCGHEELAB_FTP_PASSWORD`, or a prompt.

Add `--delete` to also remove files that were deployed earlier but no longer
exist in the repo. Add `--only rm/` to limit any command to one folder.

## Files in this folder

| File | What |
|---|---|
| `site.json` | **What the site is.** Allowlist of files/folders that map onto `mcgheelab.com/`. Add a new top-level file here when the site starts needing it. Also the FTP host/user (no password) and the folders `touch_folders.py` keeps fresh. |
| `manifest.json` | **What is live.** `path → sha256 + size + when`. Tracked in git on purpose: it is the only record of what the server has, because the server is updated from the working tree, not from commits. Rebuild it any time with `baseline` (read-only, asks the server). |
| `pending.json` | A stage/upload waiting for `verify`. Transient, git-ignored. |
| `upload/` | The staging folder `stage` builds. Regenerated every time, git-ignored. |
| `audit-YYYY-MM-DD.txt` | Output of `audit`. Lists private file names, git-ignored. |

## When something looks wrong

- **"Nothing to upload" but the site is stale** → `python3 scripts/deploy.py verify --all`. It re-checks every file against the server and un-records any that are missing or a different size, so the next `status` shows them.
- **A file I didn't touch is listed** → it genuinely differs from the server (the hash doesn't match what `verify`/`baseline` last saw). Upload it.
- **Manifest lost / new machine** → `python3 scripts/deploy.py baseline`.
- **Service worker** → nothing changes here: still bump `CACHE_VERSION` in `sw.js` for every batch, and never FTP `sw.js` during a live lecture (V3.775).

## Why not Cyberduck's own "Synchronize"?

It has to list every remote directory first (slow on FTP), compares
timestamps rather than content, and has no idea which local files are the
site. The manifest approach needs no remote listing at all: one HEAD request
per changed file, nothing for the rest.
