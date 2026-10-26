# Setting up this repo on Gabe's computer (Windows): pushing from VS Code, and FTP deploys

> For Gabe and his Claude Code. The agreement between Gabe and the lab (branches, pull requests, what lives where) is
> [CLAUDE.md](CLAUDE.md) in this folder; this page is how to get one Windows PC working the way Alex's Mac does.
> Written V3.924 (2026-10-26).

Alex works in VS Code with Claude Code. At the end of every Claude turn, the repo's Stop hooks (`.claude/settings.json`,
tracked in git) run two scripts:

- `scripts/git_autopush.py` commits the turn, rebases onto origin, runs the push check
  (`scripts/merge_check.py`) and pushes the current branch;
- `scripts/deploy.py autodeploy` uploads the site files that changed to mcgheelab.com, checks each one over HTTPS
  and records it in `deploy/manifest.json`.

Nothing is done by hand per turn. The steps below make the same thing work on Gabe's PC.

## 1. Tools

- **Git for Windows** (includes Git Bash, which Claude Code uses), **VS Code** with the **Claude Code** extension,
  **Node.js LTS** (the push check runs `node`), and the **GitHub CLI** (`winget install GitHub.cli`).
- **Python 3.9 or newer, available as `python3`** in Git Bash. The Stop hooks, the pre-push hook and the manifest
  merge driver all call `python3` by that name, and the hooks hide their errors (`|| true`): if `python3` does not
  work, nothing is committed, pushed or deployed, and nothing says so. `launch.bat` uses `python`, so that is
  probably the only name that works now. Check with `python3 --version`. If it fails or opens the Microsoft Store,
  turn off the python.exe and python3.exe entries under Settings → Apps → Advanced app settings → App execution
  aliases, then copy `python.exe` to `python3.exe` in the same folder
  (`py -3 -c "import sys; print(sys.executable)"` shows which folder).
- **certifi**: `python3 -m pip install certifi`. Windows fills its root-certificate store lazily, so Python there
  may not trust the FTP server's GoDaddy chain ("self-signed certificate in certificate chain"); `deploy.py` adds
  certifi's roots when it is installed.

## 2. Git settings, before cloning

```bash
git config --global core.autocrlf false
git config --global user.name  "<Gabe's name>"
git config --global user.email "<the email on his GitHub account>"
gh auth login        # GitHub.com → HTTPS → log in with a web browser, as RTgabrieldeclercq
gh auth setup-git    # git push uses that login, so the hook's push never stops to ask for a password
```

**`core.autocrlf false` is essential.** Git for Windows normally converts files to CRLF line endings on checkout.
Git hides that, but `deploy.py` compares each file's exact bytes with `deploy/manifest.json`, so a CRLF checkout
looks like hundreds of changed files, and the first auto-deploy from this PC would re-upload most of the site. Also
set `"files.eol": "\n"` in VS Code's user settings so new files are LF too.

## 3. Clone, then the once-per-clone steps

Clone `https://github.com/McGheeLab/McGheeLabWebsite.git` (GitHub Desktop or `git clone`), open the folder in VS Code,
then run these in its Git Bash terminal:

```bash
python3 scripts/merge_check.py install            # push gate (.githooks/pre-push) + manifest merge driver
python3 scripts/scientia_build.py                 # the two built Scientia files (git-ignored)
git ls-files --eol | grep "i/lf.*w/crlf" | head   # must print nothing
python3 scripts/deploy.py status                  # no network; should list a handful of files at most, not hundreds
```

If the CRLF check prints files, the clone was made before `core.autocrlf false` was set. If the clone is fresh and
has no work in it, fix it in place with `git rm -r -q --cached . && git reset --hard`, then run both checks again.

## 4. How pushing works

- **Nothing to do per turn.** The Stop hook commits, rebases onto `origin/<current branch>`, runs the push check,
  pushes, and reports a `git: …` system message. If that message never appears after a turn that changed files,
  the hooks are not running; check `python3` first.
- **Work on a branch, not `main`** ([CLAUDE.md](CLAUDE.md), Git workflow). Run `git switch -c scientia/<topic>`
  before the first edit; on `main`, the hook pushes straight to `main`. A new branch is pushed on its first turn
  ("pushed … (new branch)"), checked against `origin/main`.
- Open the pull request with `gh pr create --base main`; Alex reviews it. After it merges, run
  `git switch main && git pull --rebase`, and start a new branch before the next change.
- If the push check refuses the push (a module missing from `CodeLog/features.json`, an overlap with an existing
  feature, a failed gate), the commit stays local and the message says how to fix it. It tries again next turn.
  Preview with `python3 scripts/merge_check.py worktree`. Never use `--no-verify`; GitHub runs the same check on
  every pull request anyway.
- Never commit secrets or confidential files. **The repo is public.**

## 5. FTP: deploying to mcgheelab.com

Gabe has his own FTP login, `gabe@mcgheelab.com` (made 2026-10-26). Its root is the live web root, the same folder
the lab account uses. Never use the lab's login.

1. Only after the checks in step 3 pass, create `scripts/.env`. It is git-ignored; confirm with
   `git check-ignore -v scripts/.env`. Gabe types the password in himself: Claude does not ask him to paste it into
   the chat, and never echoes, logs or commits it.

   ```
   MCGHEELAB_FTP_USER=gabe@mcgheelab.com
   MCGHEELAB_FTP_PASSWORD=<Gabe types this>
   ```

2. Test the connection with `python3 scripts/deploy.py check`. It logs in, lists the web root, and uploads
   nothing. It should print `gabe@mcgheelab.com at p3plzcpnl504220.prod.phx3.secureserver.net via FTPS (explicit
   TLS)` and `OK: / is the web root.`

   - **The connection is TLS only** (`"tls": "always"` in `deploy/site.json`, V3.925). GoDaddy's FTP certificate is
     issued to the server's own name, not mcgheelab.com, so `deploy.py` connects by that name (`ftp.tlsHost`) and
     verifies it fully. If TLS fails, the deploy stops; it never falls back to plain FTP, which would send the
     password in the clear. Don't change `tls` back to `auto` and don't turn verification off. A
     "self-signed certificate in certificate chain" error means certifi is missing (step 1). A "site has moved
     servers" error means `tlsHost` needs the new Server Name from cPanel: ask Alex.
   - **WRONG FOLDER**: the account's directory in cPanel must be the web root, not a folder inside it. Ask Alex to
     fix it.

3. **Deploy only from an up-to-date `main`.** `deploy.py` refuses to run on a side branch or on a tree behind
   `origin/main`, because a stale tree would put older files over newer ones; don't override that with
   `--any-branch`. On a `scientia/` branch, a turn that changed site files ends with "auto-deploy HELD … on branch";
   that is expected. To ship merged work by hand: `git switch main && git pull --rebase`, then
   `python3 scripts/deploy.py status`, then `python3 scripts/deploy.py ftp --yes`. On `main`, the Stop hook does the
   same at the end of each turn. `deploy/manifest.json` goes into git with the change: it is how the two deployers
   share the record of what is live.

## Never

- **Never upload with Cyberduck, FileZilla or drag-and-drop.** A direct upload is not recorded in the manifest, so
  the next deploy from either computer can silently overwrite it, and it risks sending non-site files (CodeLog,
  functions, scripts, keys) to a public server. `deploy/site.json` is the only definition of what the site is.
- Don't use `deploy.py ftp --delete` unless Gabe asks for it.
- Don't deploy `sw.js` during one of Alex's live lectures. If unsure, ask, or pause deploys with
  `"autoDeploy": false` in `deploy/site.json`.
- Any change to a site file also bumps `CACHE_VERSION` in `sw.js` in the same turn (see the root `CLAUDE.md`).
